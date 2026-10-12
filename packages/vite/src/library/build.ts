import {existsSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {TARGETS, splitBlocks} from '@multifront/core';
import type {SplitResult, Target} from '@multifront/core';
import {build, mergeConfig, normalizePath} from 'vite';
import type {InlineConfig, Plugin, Rolldown} from 'vite';
import {splitId, virtualTarget} from '../ids.ts';
import {multifront} from '../plugin.ts';
import type {LibraryOptions, LibraryResult, LibraryTarget} from '../types.ts';
import {insideDir, outputName} from './names.ts';
import {libraryTargets} from './targets.ts';

// A specifier that is neither relative, absolute nor a virtual id.
const BARE = /^(?![./\0])/;
const REAL_ID = /^[^\0]/;

interface Component {
  relative: string; // from src, posix
  split: SplitResult;
}

interface TargetJob extends Omit<LibraryResult, 'files'> {
  row: LibraryTarget;
  root: string;
  src: string;
  entries: Record<string, string>;
  peers: Record<string, string>;
}

// Overlapping calls share one swap: the first in saves the caller's value, the last out puts it back.
let productionBuilds = 0;
let callerNodeEnv: string | undefined;

/** Vite reads `isProduction` from NODE_ENV: a library is a production build whatever the caller's environment. */
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

/** Types a `multifront.config.ts`; returns `options` as is. */
export function defineLibrary(options: LibraryOptions): LibraryOptions {
  return options;
}

async function scan(src: string): Promise<Component[]> {
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

async function libraryName(root: string): Promise<string | undefined> {
  const file = join(root, 'package.json');
  try {
    const {name} = JSON.parse(await readFile(file, 'utf8')) as {name?: unknown};
    return typeof name === 'string' ? name : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`buildLibrary: cannot read ${file}: ${(err as Error).message}`, {cause: err});
  }
}

async function writtenFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {recursive: true, withFileTypes: true});
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalizePath(relative(dir, join(entry.parentPath, entry.name))))
    .sort();
}

// The file behind a module id: `/abs/Card.ucf` for `/abs/Card.ucf.react.tsx` or a style id.
function fileOf(id: string): string {
  const {path} = splitId(id);
  return virtualTarget(path)?.file ?? path;
}

function shownFile(root: string, file: string): string {
  return normalizePath(relative(root, file));
}

/** Keeps the peers external, and fails on any other package or on a file outside `src`. */
function libraryPlugin({root, src, target, packageName, peers}: TargetJob): Plugin {
  const names = Object.keys(peers);
  const isPeer = (id: string) => names.some((peer) => id === peer || id.startsWith(`${peer}/`));
  const shown = (file: string) => shownFile(root, file);
  return {
    name: 'multifront:library',
    enforce: 'pre',
    resolveId: {
      filter: {id: BARE},
      async handler(id, importer, options) {
        if (isPeer(id)) return {id, external: true};
        const resolved = await this.resolve(id, importer, {...options, skipSelf: true});
        // An entry, a virtual id or an alias into `src`.
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

async function buildOne(job: TargetJob, vite: InlineConfig | undefined): Promise<LibraryResult> {
  const {target, row, root, src, outDir, entries} = job;
  const owners = new Map<string, string>();
  // Rolldown would rename a second module of the same name (`Card2.js`) without a word.
  const fileName = (chunk: Rolldown.PreRenderedChunk) => {
    const id = chunk.facadeModuleId ?? chunk.moduleIds[0]!;
    const name = `${outputName(id, src)}.js`;
    const owner = owners.get(name) ?? id;
    owners.set(name, owner);
    if (owner !== id) {
      const [first, second] = [owner, id].map((other) => shownFile(root, fileOf(other)));
      throw new Error(`buildLibrary: ${first} and ${second} would both be written as ${name}`);
    }
    return name;
  };
  const config: InlineConfig = {
    configFile: false,
    root,
    mode: 'production',
    publicDir: false,
    logLevel: 'warn',
    plugins: [await row.plugin(), multifront({framework: target, frameworks: [target]}), libraryPlugin(job)],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: true,
      // 6.2 replaces Vite's one lib CSS file with a file per component.
      lib: {entry: entries, formats: ['es'], cssFileName: 'styles'},
      rolldownOptions: {
        output: {preserveModules: true, preserveModulesRoot: src, entryFileNames: fileName, chunkFileNames: fileName},
      },
    },
  };
  await build(vite ? mergeConfig(config, vite) : config);
  return {target, outDir, packageName: job.packageName, files: await writtenFiles(outDir), skipped: job.skipped};
}

/** One real `vite build` per framework: `<outDir>/<framework>/` gets one ES module per component and plain module. */
export async function buildLibrary(options: LibraryOptions = {}): Promise<LibraryResult[]> {
  const root = normalizePath(resolve(options.root ?? process.cwd()));
  const src = normalizePath(resolve(root, options.src ?? 'src'));
  const outDir = normalizePath(resolve(root, options.outDir ?? 'dist'));
  const index = indexEntry(root, src, options.index);
  const components = await scan(src);
  const withBlock = (target: Target) => components.filter(({split}) => split.targets[target]);
  const frameworks = options.frameworks
    ? [...new Set(options.frameworks)]
    : TARGETS.filter((target) => target in libraryTargets && withBlock(target).length > 0);
  if (frameworks.length === 0) {
    throw new Error(`buildLibrary: nothing to build, no .ucf file in ${src} has a block for a framework with a library build`);
  }
  const rootName = await libraryName(root);
  const jobs = frameworks.map((target): TargetJob => {
    const row = (libraryTargets as Partial<Record<Target, LibraryTarget>>)[target];
    if (!row) throw new Error(`buildLibrary: the '${target}' framework has no library build`);
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
    };
  });
  return asProduction(async () => {
    const results: LibraryResult[] = [];
    for (const job of jobs) results.push(await buildOne(job, options.vite));
    return results;
  });
}
