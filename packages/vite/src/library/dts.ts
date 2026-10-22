import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import MagicString from 'magic-string';
import {buildTarget, createBuildContext, loadSvelteCompiler, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {Finding, VueCompiler} from '@multifront/core';
import type * as LanguageTools from '@multifront/language-tools';
import {normalizePath, parseAst} from 'vite';
import type {Lang, LibraryTypesJob} from '../types.ts';
import {rewriteScript, rewriteSpecifiers, frontRenamer} from './specifiers.ts';
import {LibraryError, libraryError} from './errors.ts';
import {clashMessage, fileKey, filesIn, shownFile} from './names.ts';
import {shippedSource, svelteShipped} from './source.ts';

/** How one framework turns a staged `src/` into `.d.ts` files. */
interface TypesTool {
  peer: string; // the package that runs the check
  bin: string; // its bin name
  frontExt: '.tsx' | '.vue' | '.svelte'; // what a `.front` file is staged as
  specifierExt: '.js' | '.vue' | '.svelte'; // what a `.front` specifier becomes in the stage
  compilerOptions: Record<string, unknown>;
  stageFront(file: string, source: string, root: string, compiler: VueCompiler): Promise<string>;
  stageSvelte?(source: string, root: string): string; // a plain `.svelte` file, when the tool types them
}

const DECLARATION = /\.d\.[cm]?ts$/;
const SCRIPT = /\.[cm]?([jt]sx?)$/;
// Used only when the library has no tsconfig.json of its own.
const DEFAULT_OPTIONS = {target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, skipLibCheck: true};
const EMIT_OPTIONS = {
  allowJs: true,
  declaration: true,
  emitDeclarationOnly: true,
  declarationMap: false,
  sourceMap: false,
  noEmit: false,
  composite: false,
  incremental: false,
  rootDir: '.',
};

function langOf(file: string): Lang | undefined {
  if (DECLARATION.test(file)) return 'dts';
  return SCRIPT.exec(file)?.[1] as Lang | undefined;
}

/** From the library root, like its compilers: the library's own versions run. */
function resolvePeer(job: LibraryTypesJob, peer: string, request = peer): string {
  try {
    return createRequire(join(job.root, 'package.json')).resolve(request);
  } catch {
    throw new Error(`buildLibrary: the ${job.target} types need ${peer}; install it, or set dts: false`);
  }
}

function toolBin(job: LibraryTypesJob, {peer, bin}: TypesTool): string {
  const manifest = resolvePeer(job, peer, `${peer}/package.json`);
  const bins = (JSON.parse(readFileSync(manifest, 'utf8')) as {bin: Record<string, string>}).bin;
  return join(dirname(manifest), bins[bin]!);
}

function reactTool(job: LibraryTypesJob): TypesTool {
  let languageTools: Promise<typeof LanguageTools> | undefined;
  return {
    peer: 'typescript',
    bin: 'tsc',
    frontExt: '.tsx',
    specifierExt: '.js',
    compilerOptions: {jsx: 'react-jsx'},
    async stageFront(file, source, _root, compiler) {
      languageTools ??= import(pathToFileURL(resolvePeer(job, '@multifront/language-tools')).href);
      const script = (await languageTools).getTypesScript(file, source, 'react', {compiler});
      if (!script) throw new Error(`buildLibrary: ${file} has no <react> block`);
      return rewriteScript(script.code, 'tsx', `${file}.tsx`, '.js');
    },
  };
}

const vueTool: TypesTool = {
  peer: 'vue-tsc',
  bin: 'vue-tsc',
  frontExt: '.vue',
  specifierExt: '.vue',
  compilerOptions: {},
  async stageFront(file, source, root, compiler) {
    const split = splitBlocks(source, file);
    const {code} = buildTarget(split, await createBuildContext(split, {root, compiler, production: true}), 'vue');
    if (!code.includes('.front')) return code;
    const text = new MagicString(code);
    const {descriptor} = compiler.parse(code, {filename: file});
    for (const script of [descriptor.script, descriptor.scriptSetup]) {
      if (!script) continue;
      const lang = langOf(`.${script.lang ?? 'js'}`) ?? 'js';
      rewriteSpecifiers(text, script.content, script.loc.start.offset, lang, `${file}.${lang}`, frontRenamer('.vue'));
    }
    return text.toString();
  },
};

function svelteTool(job: LibraryTypesJob): TypesTool {
  return {
    peer: 'typescript',
    bin: 'tsc',
    frontExt: '.svelte',
    specifierExt: '.svelte',
    compilerOptions: {},
    // The shipped text: its `.d.ts` types what consumers import.
    async stageFront(file, source, root) {
      return (await shippedSource(splitBlocks(source, file), root, job.src, 'svelte')).code;
    },
    // Unpreprocessed, as svelte-package types its sources: a script preprocessor would strip the types.
    stageSvelte(source, root) {
      return source.includes('.front') ? svelteShipped(source, loadSvelteCompiler(root)) : source;
    },
  };
}

interface Staged {
  shown: Map<string, string>; // staged path → the source path errors show
  roots: string[]; // the staged JS build modules and `.d.ts` files of `src`
  components: string[]; // the staged `.front` files
}

async function stageSources(job: LibraryTypesJob, tool: TypesTool, stage: string): Promise<Staged> {
  const compiler = loadVueCompiler(job.root);
  const modules = new Set(job.modules);
  const staged: Staged = {shown: new Map(), roots: [], components: []};
  for (const name of await filesIn(job.src)) {
    const file = `${job.src}/${name}`;
    const isFront = name.endsWith('.front');
    if (isFront && !modules.has(name)) continue;
    const path = isFront ? name.slice(0, -'.front'.length) + tool.frontExt : name;
    const target = join(stage, path);
    await mkdir(dirname(target), {recursive: true});
    const lang = langOf(name);
    if (isFront) await writeFile(target, await tool.stageFront(file, await readFile(file, 'utf8'), job.root, compiler));
    else if (tool.stageSvelte && name.endsWith('.svelte'))
      await writeFile(target, tool.stageSvelte(await readFile(file, 'utf8'), job.root));
    else if (lang) await writeFile(target, rewriteScript(await readFile(file, 'utf8'), lang, file, tool.specifierExt));
    else await copyFile(file, target);
    staged.shown.set(path, shownFile(job.root, file));
    if (modules.has(name) || DECLARATION.test(name)) staged.roots.push(path);
    if (isFront) staged.components.push(path);
  }
  return staged;
}

async function writeTsconfig(job: LibraryTypesJob, tool: TypesTool, stage: string, files: string[]): Promise<void> {
  const library = join(job.root, 'tsconfig.json');
  const own = existsSync(library);
  const config = {
    ...(own && {extends: normalizePath(library)}),
    compilerOptions: {
      ...(!own && DEFAULT_OPTIONS),
      ...EMIT_OPTIONS,
      ...tool.compilerOptions,
      outDir: job.outDir,
      declarationDir: job.outDir,
    },
    files,
    include: [],
  };
  await writeFile(join(stage, 'tsconfig.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function runTool(bin: string, stage: string, args: string[] = []): Promise<{code: number | null; output: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '-p', 'tsconfig.json', '--pretty', 'false', ...args], {cwd: stage});
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({code, output}));
  });
}

// `file(line,col): error TS2322: message`, file and position each optional.
const TSC_LINE = /^(?:(.+?)(?:\((\d+),(\d+)\))?: )?(error|warning) (TS\d+): (.*)$/;

/** Staged paths become source paths; a position in a generated `.front` script is not one in the `.front` file. */
function compileError(job: LibraryTypesJob, output: string, shown: Map<string, string>): LibraryError {
  const lines: string[] = [];
  const findings: Finding[] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    // The listing run's file list: only its diagnostics count.
    if (isAbsolute(line.trim())) continue;
    const match = TSC_LINE.exec(line);
    if (!match) {
      lines.push(line);
      // Any other line, tsc's indented follow-ups, goes on with the message above it.
      const last = findings.at(-1);
      if (last) last.message += ` ${line.trim()}`;
      continue;
    }
    const [, staged, row, column, severity, code, message] = match;
    const source = staged === undefined ? undefined : shown.get(normalizePath(staged));
    const unplaced = source === undefined || row === undefined || source.endsWith('.front');
    const position = unplaced ? undefined : {line: Number(row), column: Number(column)};
    lines.push(source === undefined ? line : `${source}${position ? `(${row},${column})` : ''}: ${severity} ${code}: ${message}`);
    const file = source && `${job.root}/${source}`;
    findings.push({...(file && {file}), ...position, code: code!, severity: severity as Finding['severity'], message: message!});
  }
  return new LibraryError(`buildLibrary: the ${job.target} types do not compile:\n${lines.join('\n')}`, findings);
}

/** Every staged file the program reaches: tsc emits nothing for one under `node_modules` unless it is a root. */
async function reachedRoots(bin: string, stage: string, job: LibraryTypesJob, shown: Map<string, string>): Promise<string[]> {
  // The stage is under `node_modules`: tsc drops a JS module past this depth, and a type-only one is no root.
  // Without `jsx` tsc skips a `.jsx` module: the real run reports it, svelte2tsx's emit would drop it silently.
  const listing = ['--listFilesOnly', '--maxNodeModuleJsDepth', String(2 ** 30), '--jsx', 'preserve'];
  const {code, output} = await runTool(bin, stage, listing);
  // Only this run loads an untyped package's JS, whose syntax tsc may reject: errors there are not the library's.
  const errors = output.split(/\r?\n/).flatMap((line) => {
    const match = TSC_LINE.exec(line);
    return match ? [match[1]] : [];
  });
  const outside = errors.length > 0 && errors.every((file) => file?.startsWith('../'));
  if (code !== 0 && !outside) throw compileError(job, output, shown);
  // tsc prints the real path, past any symlink in the library root.
  const stageDir = normalizePath(await realpath(stage));
  return output
    .split('\n')
    .map((line) => normalizePath(line.trim()))
    .flatMap((file) => (file.startsWith(`${stageDir}/`) ? [file.slice(stageDir.length + 1)] : []))
    .sort();
}

/** A fresh stage under the library's own `node_modules`, so its packages resolve; deleted after. */
async function withStage<Result>(job: LibraryTypesJob, run: (stage: string) => Promise<Result>): Promise<Result> {
  const cache = join(job.root, 'node_modules', '.cache', 'multifront');
  await mkdir(cache, {recursive: true});
  const stage = await mkdtemp(join(cache, `types-${job.target}-`));
  try {
    return await run(stage);
  } finally {
    await rm(stage, {recursive: true, force: true});
  }
}

function declarationName(tool: TypesTool, path: string, isComponent: boolean): string {
  return isComponent ? `${path.slice(0, -tool.frontExt.length)}.d.ts` : path.replace(/\.([cm]?)[jt]sx?$/, '.d.$1ts');
}

function clashError(job: LibraryTypesJob, one: {name: string; shown: string}, other: {name: string; shown: string}) {
  const [first, second] = [one, other].sort((left, right) => (left.shown < right.shown ? -1 : 1));
  return libraryError(
    'name-clash',
    `${job.root}/${first!.shown}`,
    clashMessage(first!.shown, first!.name, second!.shown, second!.name)
  );
}

/** A type-only module has no chunk: only its `.d.ts` name can clash with a component's. `caseOnly`: case-only clashes. */
function checkDeclarationNames(
  job: LibraryTypesJob,
  tool: TypesTool,
  paths: string[],
  shown: Map<string, string>,
  components: Set<string>,
  caseOnly = false
): void {
  const owners = new Map<string, {name: string; shown: string}>();
  for (const path of paths) {
    if (!shown.has(path)) continue;
    const name = declarationName(tool, path, components.has(path));
    if (name === path) continue;
    const declaration = {name, shown: shown.get(path)!};
    const owner = owners.get(fileKey(name));
    if (owner && !(caseOnly && owner.name === name)) throw clashError(job, owner, declaration);
    owners.set(fileKey(name), declaration);
  }
}

async function emitTypes(job: LibraryTypesJob, tool: TypesTool): Promise<string[]> {
  const bin = toolBin(job, tool);
  return withStage(job, async (stage) => {
    const {shown, roots, components} = await stageSources(job, tool, stage);
    // On macOS and Windows tsc resolves `./card.js` to Card.tsx and fails on its casing before any check of ours.
    checkDeclarationNames(job, tool, [...shown.keys()], shown, new Set(components), true);
    await writeTsconfig(job, tool, stage, roots);
    const reached = await reachedRoots(bin, stage, job, shown);
    checkDeclarationNames(job, tool, reached, shown, new Set(components));
    await writeTsconfig(job, tool, stage, reached);
    const {code, output} = await runTool(bin, stage);
    if (code !== 0) throw compileError(job, output, shown);
    return components;
  });
}

/** `Card.vue.d.ts` → `Card.d.ts`, and `./Card.vue` → `./Card.js` in every declaration. */
async function finishVueTypes(outDir: string, components: Set<string>): Promise<void> {
  for (const file of await filesIn(outDir)) {
    if (file.endsWith('.vue.d.ts') && components.has(file.slice(0, -'.d.ts'.length)))
      await rename(join(outDir, file), join(outDir, file.slice(0, -'.vue.d.ts'.length) + '.d.ts'));
  }
  for (const file of await filesIn(outDir)) {
    if (!DECLARATION.test(file)) continue;
    const path = join(outDir, file);
    const code = await readFile(path, 'utf8');
    if (!code.includes('.vue')) continue;
    const text = new MagicString(code);
    rewriteSpecifiers(text, code, 0, 'dts', path, (specifier) => {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      return relative && components.has(posix.join(posix.dirname(file), specifier))
        ? specifier.slice(0, -'.vue'.length) + '.js'
        : undefined;
    });
    if (text.hasChanged()) await writeFile(path, text.toString());
  }
}

/** Real `tsc` over `Card.tsx` files made from each `.front` file's React types script. */
export async function emitReactTypes(job: LibraryTypesJob): Promise<void> {
  await emitTypes(job, reactTool(job));
}

/** Real `vue-tsc` over `Card.vue` files made from each `.front` file's SFC code. */
export async function emitVueTypes(job: LibraryTypesJob): Promise<void> {
  await finishVueTypes(job.outDir, new Set(await emitTypes(job, vueTool)));
}

interface Svelte2tsx {
  svelte2tsx(
    code: string,
    options: {filename: string; isTsFile: boolean; mode: 'dts'; noSvelteComponentTyped: boolean}
  ): {
    code: string;
  };
  emitDts(config: {libRoot: string; declarationDir: string; svelteShimsPath: string; tsconfig: string}): Promise<void>;
}

// svelte2tsx's own test for a TypeScript component.
const TS_SCRIPT = /<script\s+[^>]*?lang=('|")(ts|typescript)('|")/;

/** TypeScript 6 checks side-effect imports: a `.svelte.d.ts` keeps its component's `import "./Card.css"`. */
async function dropCssImports(outDir: string, components: string[]): Promise<void> {
  for (const component of components) {
    const path = join(outDir, `${component}.d.ts`);
    if (!existsSync(path)) continue;
    const code = await readFile(path, 'utf8');
    const text = new MagicString(code);
    for (const node of parseAst(code, {lang: 'dts'}, path).body) {
      if (node.type !== 'ImportDeclaration' || node.specifiers.length > 0 || !String(node.source.value).endsWith('.css'))
        continue;
      const {start, end} = node as unknown as {start: number; end: number};
      text.remove(start, code[end] === '\n' ? end + 1 : end);
    }
    if (text.hasChanged()) await writeFile(path, text.toString());
  }
}

/** svelte2tsx's `emitDts`, as svelte-package runs it, over `Card.svelte` files holding the shipped code. */
export async function emitSvelteTypes(job: LibraryTypesJob): Promise<void> {
  const tool = svelteTool(job);
  const bin = toolBin(job, tool);
  // svelte2tsx, a pinned dependency of language-tools: the version that types the editor.
  const require = createRequire(resolvePeer(job, '@multifront/language-tools'));
  const svelte2tsx = require('svelte2tsx') as Svelte2tsx;
  const shims = require.resolve('svelte2tsx/svelte-shims-v4.d.ts');
  await withStage(job, async (stage) => {
    const {shown, roots, components} = await stageSources(job, tool, stage);
    // tsc lists what a `.svelte` file reaches through svelte2tsx's script of it, written beside it for that run only.
    const copies = new Map<string, string>();
    const staged = new Map([...shown.keys()].map((path) => [fileKey(path), path]));
    for (const file of roots.filter((path) => path.endsWith('.svelte'))) {
      const filename = join(stage, file);
      const code = await readFile(filename, 'utf8');
      // TypeScript even for a JS component: svelte2tsx writes type declarations into it.
      const copy = `${file}.ts`;
      // tsc and consumers resolve `./Icon.svelte` and `./Icon.svelte.js` alike: to `Icon.svelte.d.ts`.
      const module = [copy, `${file}.js`].map((path) => staged.get(fileKey(path))).find((path) => path !== undefined);
      if (module !== undefined) {
        const declaration = `${module.slice(0, -'.ts'.length)}.d.ts`;
        const message = clashMessage(shown.get(file)!, `${file}.d.ts`, shown.get(module)!, declaration);
        throw libraryError('name-clash', `${job.root}/${shown.get(file)!}`, message);
      }
      const script = svelte2tsx.svelte2tsx(code, {
        filename,
        isTsFile: TS_SCRIPT.test(code),
        mode: 'dts',
        noSvelteComponentTyped: true,
      });
      await writeFile(join(stage, copy), script.code);
      copies.set(file, copy);
      shown.set(copy, shown.get(file)!);
    }
    await writeTsconfig(job, tool, stage, [...roots.map((root) => copies.get(root) ?? root), shims]);
    const scripts = new Map([...copies].map(([file, copy]) => [copy, file]));
    const reached = (await reachedRoots(bin, stage, job, shown)).map((file) => scripts.get(file) ?? file);
    for (const copy of copies.values()) await rm(join(stage, copy));
    await writeTsconfig(job, tool, stage, reached);
    await svelte2tsx.emitDts({
      libRoot: stage,
      declarationDir: job.outDir,
      svelteShimsPath: shims,
      tsconfig: join(stage, 'tsconfig.json'),
    });
    await dropCssImports(job.outDir, components);
  });
}
