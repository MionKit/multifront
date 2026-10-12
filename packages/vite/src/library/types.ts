import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, posix, relative} from 'node:path';
import MagicString from 'magic-string';
import {buildTarget, createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {Target, VueCompiler} from '@multifront/core';
import type * as LanguageTools from '@multifront/language-tools';
import {normalizePath, parseAst} from 'vite';
import type {LibraryTypesJob} from '../types.ts';
import {shownFile} from './names.ts';

type Lang = 'js' | 'jsx' | 'ts' | 'tsx' | 'dts';

/** How one framework turns a staged `src/` into `.d.ts` files. */
interface TypesTool {
  peer: string; // the package that runs the check
  bin: string; // its bin name
  ucfExt: '.tsx' | '.vue'; // what a `.ucf` file is staged as
  specifierExt: '.js' | '.vue'; // what a `.ucf` specifier becomes in the stage
  compilerOptions: Record<string, unknown>;
  stageUcf(file: string, source: string, root: string, compiler: VueCompiler): Promise<string>;
}

const require = createRequire(import.meta.url);
const LANGS: [string, Lang][] = [
  ['.d.ts', 'dts'],
  ['.d.mts', 'dts'],
  ['.d.cts', 'dts'],
  ['.ts', 'ts'],
  ['.mts', 'ts'],
  ['.cts', 'ts'],
  ['.tsx', 'tsx'],
  ['.js', 'js'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.jsx', 'jsx'],
];
const SOURCE_NODES = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ImportExpression',
  'TSImportType',
]);
const ROOT_EXT = /\.(?:[cm]?tsx?|vue)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
// Used only when the library has no tsconfig.json of its own.
const DEFAULT_OPTIONS = {target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, skipLibCheck: true};
const EMIT_OPTIONS = {
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
  return LANGS.find(([ext]) => file.endsWith(ext))?.[1];
}

function missingPeer(target: Target, peer: string): Error {
  return new Error(`buildLibrary: the ${target} types need ${peer}; install it, or set dts: false`);
}

function toolBin(target: Target, {peer, bin}: TypesTool): string {
  let manifest: string;
  try {
    manifest = require.resolve(`${peer}/package.json`);
  } catch {
    throw missingPeer(target, peer);
  }
  const bins = (JSON.parse(readFileSync(manifest, 'utf8')) as {bin: Record<string, string>}).bin;
  return join(dirname(manifest), bins[bin]!);
}

async function languageTools(): Promise<typeof LanguageTools> {
  try {
    return await import('@multifront/language-tools');
  } catch (err) {
    const {code, message} = err as NodeJS.ErrnoException;
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes("'@multifront/language-tools'"))
      throw missingPeer('react', '@multifront/language-tools');
    throw err;
  }
}

/** Every string-literal module specifier: imports, re-exports, `import()` and `import()` types. */
function specifiersOf(code: string, lang: Lang, filename: string): {value: string; start: number; end: number}[] {
  let program: unknown;
  try {
    program = parseAst(code, {lang}, filename);
  } catch {
    // tsc reports the syntax error with its own position.
    return [];
  }
  const found: {value: string; start: number; end: number}[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type: string; value: unknown; raw?: string; start: number; end: number}};
    const {source} = node;
    if (typeof node.type === 'string' && SOURCE_NODES.has(node.type) && source?.type === 'Literal') {
      // An escaped specifier's value is not its text: left alone.
      if (typeof source.value === 'string' && source.raw?.slice(1, -1) === source.value)
        found.push({value: source.value, start: source.start + 1, end: source.end - 1});
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(program);
  return found;
}

function rewriteSpecifiers(
  text: MagicString,
  code: string,
  offset: number,
  lang: Lang,
  filename: string,
  renamed: (specifier: string) => string | undefined
): void {
  for (const {value, start, end} of specifiersOf(code, lang, filename)) {
    const next = renamed(value);
    if (next !== undefined) text.overwrite(offset + start, offset + end, next);
  }
}

function ucfRenamer(ext: string): (specifier: string) => string | undefined {
  return (specifier) =>
    (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.ucf')
      ? specifier.slice(0, -'.ucf'.length) + ext
      : undefined;
}

function rewriteScript(code: string, lang: Lang, filename: string, ext: string): string {
  if (!code.includes('.ucf')) return code;
  const text = new MagicString(code);
  rewriteSpecifiers(text, code, 0, lang, filename, ucfRenamer(ext));
  return text.toString();
}

const reactTool: TypesTool = {
  peer: 'typescript',
  bin: 'tsc',
  ucfExt: '.tsx',
  specifierExt: '.js',
  compilerOptions: {jsx: 'react-jsx'},
  async stageUcf(file, source, _root, compiler) {
    const script = (await languageTools()).getTypesScript(file, source, 'react', {compiler});
    if (!script) throw new Error(`buildLibrary: ${file} has no <react> block`);
    return rewriteScript(script.code, 'tsx', `${file}.tsx`, '.js');
  },
};

const vueTool: TypesTool = {
  peer: 'vue-tsc',
  bin: 'vue-tsc',
  ucfExt: '.vue',
  specifierExt: '.vue',
  compilerOptions: {},
  async stageUcf(file, source, root, compiler) {
    const split = splitBlocks(source, file);
    const {code} = buildTarget(split, await createBuildContext(split, {root, compiler, production: true}), 'vue');
    if (!code.includes('.ucf')) return code;
    const text = new MagicString(code);
    const {descriptor} = compiler.parse(code, {filename: file});
    for (const script of [descriptor.script, descriptor.scriptSetup]) {
      if (!script) continue;
      const lang = langOf(`.${script.lang ?? 'js'}`) ?? 'js';
      rewriteSpecifiers(text, script.content, script.loc.start.offset, lang, `${file}.${lang}`, ucfRenamer('.vue'));
    }
    return text.toString();
  },
};

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {recursive: true, withFileTypes: true});
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalizePath(relative(dir, join(entry.parentPath, entry.name))))
    .sort();
}

/** Copies `src` into `stage`; returns each staged path → the source path shown in errors. */
async function stageSources(job: LibraryTypesJob, tool: TypesTool, stage: string): Promise<Map<string, string>> {
  const compiler = loadVueCompiler(job.root);
  const modules = new Set(job.modules);
  const shown = new Map<string, string>();
  for (const name of await filesIn(job.src)) {
    const file = `${job.src}/${name}`;
    let staged = name;
    if (name.endsWith('.ucf')) {
      if (!modules.has(name)) continue;
      staged = name.slice(0, -'.ucf'.length) + tool.ucfExt;
    }
    const target = join(stage, staged);
    await mkdir(dirname(target), {recursive: true});
    const lang = langOf(name);
    if (staged !== name) await writeFile(target, await tool.stageUcf(file, await readFile(file, 'utf8'), job.root, compiler));
    else if (lang) await writeFile(target, rewriteScript(await readFile(file, 'utf8'), lang, file, tool.specifierExt));
    else await copyFile(file, target);
    shown.set(staged, shownFile(job.root, file));
  }
  return shown;
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

/** Staged paths become source paths; a position in a generated `.ucf` script is not one in the `.ucf` file. */
function shownOutput(output: string, shown: Map<string, string>): string {
  return output
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^(.+?)\((\d+),(\d+)\): /.exec(line);
      const source = match && shown.get(normalizePath(match[1]!));
      if (!match || !source) return line;
      const position = source.endsWith('.ucf') ? '' : `(${match[2]},${match[3]})`;
      return `${source}${position}: ${line.slice(match[0].length)}`;
    })
    .join('\n');
}

/** Every staged file the program reaches: tsc emits nothing for one under `node_modules` unless it is a root. */
async function reachedRoots(bin: string, stage: string, target: Target): Promise<string[]> {
  const {code, output} = await runTool(bin, stage, ['--listFilesOnly']);
  if (code !== 0) throw new Error(`buildLibrary: the ${target} types cannot be listed:\n${output.trim()}`);
  const stageDir = normalizePath(stage);
  return output
    .split('\n')
    .map((line) => normalizePath(line.trim()))
    .flatMap((file) => {
      const inStage = file.startsWith(`${stageDir}/`) ? file.slice(stageDir.length + 1) : undefined;
      return inStage && ROOT_EXT.test(inStage) ? [inStage] : [];
    })
    .sort();
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
      const relativeSpecifier = specifier.startsWith('./') || specifier.startsWith('../');
      const resolved = posix.join(posix.dirname(file), specifier);
      return relativeSpecifier && components.has(resolved) ? specifier.slice(0, -'.vue'.length) + '.js' : undefined;
    });
    if (text.hasChanged()) await writeFile(path, text.toString());
  }
}

async function emitTypes(job: LibraryTypesJob, tool: TypesTool): Promise<string[]> {
  const bin = toolBin(job.target, tool);
  const cache = join(job.root, 'node_modules', '.cache', 'multifront');
  await mkdir(cache, {recursive: true});
  const stage = await mkdtemp(join(cache, `types-${job.target}-`));
  try {
    const shown = await stageSources(job, tool, stage);
    const staged = [...shown.keys()];
    const modules = new Set(
      job.modules.map((name) => (name.endsWith('.ucf') ? name.slice(0, -'.ucf'.length) + tool.ucfExt : name))
    );
    await writeTsconfig(
      job,
      tool,
      stage,
      staged.filter((name) => modules.has(name) || DECLARATION.test(name))
    );
    await writeTsconfig(job, tool, stage, await reachedRoots(bin, stage, job.target));
    const {code, output} = await runTool(bin, stage);
    if (code !== 0) throw new Error(`buildLibrary: the ${job.target} types do not compile:\n${shownOutput(output, shown)}`);
    return staged.filter((name) => name.endsWith(tool.ucfExt) && shown.get(name)!.endsWith('.ucf'));
  } finally {
    await rm(stage, {recursive: true, force: true});
  }
}

/** Real `tsc` over `Card.tsx` files made from each `.ucf` file's React types script. */
export async function emitReactTypes(job: LibraryTypesJob): Promise<void> {
  await emitTypes(job, reactTool);
}

/** Real `vue-tsc` over `Card.vue` files made from each `.ucf` file's SFC code. */
export async function emitVueTypes(job: LibraryTypesJob): Promise<void> {
  const components = await emitTypes(job, vueTool);
  await finishVueTypes(job.outDir, new Set(components));
}
