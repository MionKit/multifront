import {existsSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {TARGETS, isTarget, splitBlocks} from '@multifront/core';
import type {Target} from '@multifront/core';
import {build, mergeConfig, normalizePath} from 'vite';
import type {InlineConfig, Plugin, Rolldown} from 'vite';
import {multifront} from '../plugin.ts';
import type {LibraryComponent, LibraryOptions, LibraryPackageJob, LibraryResult, LibraryTarget} from '../types.ts';
import {libraryCss} from './css.ts';
import {clashMessage, fileKey, fileOf, filesIn, insideDir, isPeer, outputName, shownFile} from './names.ts';
import {writePackageJson} from './packageJson.ts';
import {librarySource} from './source.ts';
import {libraryTargets} from './targets.ts';
import {libraryUseClient} from './useClient.ts';

// Not relative, absolute or virtual.
const BARE = /^(?![./\0])/;
const REAL_ID = /^[^\0]/;

interface TargetJob extends LibraryPackageJob, Pick<LibraryResult, 'target' | 'skipped'> {
  row: LibraryTarget;
  src: string;
  entries: Record<string, string>;
  sources: LibraryComponent[]; // the `.ucf` files with this target's block
}

// Overlapping calls share one swap: first in saves the caller's value, last out restores it.
let productionBuilds = 0;
let callerNodeEnv: string | undefined;

/** Vite reads `isProduction` from NODE_ENV; a library always builds for production. */
async function asProduction<Result>(run: () => Promise<Result>): Promise<Result> {
  if (productionBuilds++ === 0) callerNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await run();
  } finally {
    if (--productionBuilds === 0) {
      if (callerNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = callerNodeEnv;
    }
  }
}

/** Types a `multifront.config.ts`. */
export function defineLibrary(options: LibraryOptions): LibraryOptions {
  return options;
}

async function scan(src: string): Promise<LibraryComponent[]> {
  const names = (await readdir(src, {recursive: true})).filter((name) => name.endsWith('.ucf')).map(normalizePath);
  return Promise.all(
    names.sort().map(async (name) => {
      const file = `${src}/${name}`;
      return {relative: name, split: splitBlocks(await readFile(file, 'utf8'), file)};
    })
  );
}

function indexEntry(root: string, src: string, index: string | false | undefined): string | undefined {
  if (index === false) return undefined;
  const file = index === undefined ? `${src}/index.ts` : normalizePath(resolve(root, index));
  if (existsSync(file)) return file;
  if (index !== undefined) throw new Error(`buildLibrary: the index ${index} does not exist in ${root}`);
  return undefined;
}

async function libraryManifest(root: string): Promise<Record<string, unknown>> {
  const file = join(root, 'package.json');
  try {
    return (JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`buildLibrary: cannot read ${file}: ${(err as Error).message}`, {cause: err});
  }
}

/** Peers stay external; any other package or file outside `src` fails. */
function libraryPlugin({root, src, target, packageName, peers}: TargetJob): Plugin {
  const shown = (file: string) => shownFile(root, file);
  return {
    name: 'multifront:library',
    enforce: 'pre',
    resolveId: {
      filter: {id: BARE},
      async handler(id, importer, options) {
        if (isPeer(peers, id)) return {id, external: true};
        const resolved = await this.resolve(id, importer, {...options, skipSelf: true});
        // A virtual id, an alias into `src` or a Windows entry (`C:/…` passes the filter).
        if (resolved && !resolved.external && (resolved.id.startsWith('\0') || insideDir(src, fileOf(resolved.id)))) {
          return resolved;
        }
        const by = importer === undefined ? 'an entry' : shown(fileOf(importer));
        this.error(
          `"${id}" is imported by ${by}, but it is not a peer dependency of ${packageName}: ` +
            `a library package has peer dependencies only. Add it to packages.${target}.peers to keep it external.`
        );
      },
    },
    load: {
      filter: {id: REAL_ID},
      handler(id) {
        const file = fileOf(id);
        if (insideDir(src, file) === undefined) {
          this.error(`${shown(file)} is outside ${shown(src)}: a library package ships only the files of its src folder`);
        }
      },
    },
  };
}

/** The real files of `src` the build wrote, `.ucf` sub-modules counted as their file. */
function writtenModules(src: string, modules: Set<string>): Plugin {
  return {
    name: 'multifront:library-modules',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const relative = id.startsWith('\0') ? undefined : insideDir(src, fileOf(id));
          if (relative !== undefined) modules.add(relative);
        }
      }
    },
  };
}

async function buildOne(job: TargetJob, options: LibraryOptions): Promise<LibraryResult> {
  const {target, row, root, src, outDir, entries} = job;
  const modules = new Set<string>();
  const owners = new Map<string, {id: string; name: string}>();
  // Rolldown would silently rename a second module of the same name, in any case, to `Card2.js`.
  const fileName = (chunk: Rolldown.PreRenderedChunk) => {
    const id = chunk.facadeModuleId ?? chunk.moduleIds[0]!;
    const name = `${outputName(id, src)}.js`;
    const owner = owners.get(fileKey(name)) ?? {id, name};
    owners.set(fileKey(name), owner);
    if (owner.id !== id) {
      // Sorted: Rolldown's naming order is not the source order.
      const [first, second] = [owner, {id, name}]
        .map((other) => ({...other, shown: shownFile(root, fileOf(other.id))}))
        .sort((one, other) => (one.shown < other.shown ? -1 : 1));
      throw new Error(clashMessage(first!.shown, first!.name, second!.shown, second!.name));
    }
    return name;
  };
  const config: InlineConfig = {
    configFile: false,
    root,
    mode: 'production',
    publicDir: false,
    logLevel: 'warn',
    plugins: [
      await row.plugin(),
      multifront({framework: target, frameworks: [target]}),
      libraryPlugin(job),
      libraryCss(root, src),
      // After `libraryCss`: its CSS import must come below the directive.
      row.useClient && libraryUseClient(),
      writtenModules(src, modules),
      // After `libraryCss`, which orders `styles.css` by the component chunks this drops.
      row.sourceExt !== undefined &&
        librarySource({target, root, src, sourceExt: row.sourceExt, peers: job.peers, components: job.sources}),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: true,
      lib: {entry: entries, formats: ['es']},
      rolldownOptions: {
        output: {preserveModules: true, preserveModulesRoot: src, entryFileNames: fileName, chunkFileNames: fileName},
      },
    },
  };
  await build(options.vite ? mergeConfig(config, options.vite) : config);
  if (options.dts !== false) await row.emitTypes({target, root, src, outDir, modules: [...modules].sort()});
  await writePackageJson(job);
  return {target, outDir, packageName: job.packageName, files: await filesIn(outDir), skipped: job.skipped};
}

/** One `vite build` per framework into `<outDir>/<framework>/`: a file per component (Svelte uncompiled) and plain module. */
export async function buildLibrary(options: LibraryOptions = {}): Promise<LibraryResult[]> {
  const root = normalizePath(resolve(options.root ?? process.cwd()));
  const src = normalizePath(resolve(root, options.src ?? 'src'));
  const outDir = normalizePath(resolve(root, options.outDir ?? 'dist'));
  const index = indexEntry(root, src, options.index);
  const components = await scan(src);
  const withBlock = (target: Target) => components.filter(({split}) => split.targets[target]);
  // A JS config reaches here untyped: a string would spread into letters.
  if (options.frameworks !== undefined && !Array.isArray(options.frameworks)) {
    throw new Error(`buildLibrary: frameworks must be an array of framework names, got ${JSON.stringify(options.frameworks)}`);
  }
  const frameworks = options.frameworks
    ? [...new Set(options.frameworks)]
    : TARGETS.filter((target) => withBlock(target).length > 0);
  if (frameworks.length === 0) throw new Error(`buildLibrary: nothing to build, no .ucf file in ${src} has a framework block`);
  // A JS config reaches here untyped.
  const unknown = frameworks.find((target) => !isTarget(target));
  if (unknown !== undefined) throw new Error(`buildLibrary: unknown framework '${unknown}'; use ${TARGETS.join(', ')}`);
  const manifest = await libraryManifest(root);
  const rootName = typeof manifest.name === 'string' ? manifest.name : undefined;
  const jobs = frameworks.map((target): TargetJob => {
    const row: LibraryTarget = libraryTargets[target];
    const withTargetBlock = withBlock(target);
    if (withTargetBlock.length === 0) throw new Error(`buildLibrary: no .ucf file in ${src} has a <${target}> block`);
    const packageName = options.packages?.[target]?.name ?? (rootName && `${rootName}-${target}`);
    if (!packageName) throw new Error(`buildLibrary: ${root}/package.json has no name; set packages.${target}.name`);
    const entries = Object.fromEntries(withTargetBlock.map((component) => [component.relative, `${src}/${component.relative}`]));
    if (index) entries[relative(src, index)] = index;
    return {
      target,
      row,
      root,
      src,
      outDir: `${outDir}/${target}`,
      entries,
      skipped: components.filter((component) => !withTargetBlock.includes(component)).map((component) => component.relative),
      packageName,
      peers: {...row.peers, ...options.packages?.[target]?.peers},
      manifest,
      index: index && outputName(index, src),
      components: withTargetBlock.map((component) => outputName(`${src}/${component.relative}`, src)),
      componentExt: row.sourceExt ?? '.js',
      conditions: row.conditions ?? ['default'],
      sources: withTargetBlock,
    };
  });
  return asProduction(async () => {
    const results: LibraryResult[] = [];
    for (const job of jobs) results.push(await buildOne(job, options));
    return results;
  });
}
