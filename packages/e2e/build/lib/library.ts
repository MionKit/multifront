import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {buildLibrary} from '@multifront/vite';
import type {LibraryOptions, LibraryResult} from '@multifront/vite';
import {parseSync} from 'oxc-parser';
import type {ParseResult} from 'oxc-parser';
import {FIXTURES_DIR, LIBRARY_DIR, TMP_DIR, copyLibrary, literalSpecifiers, removeLibrary} from '../../fixtures/index.ts';

// Plain Svelte component, runes module and the `svelte.config.js` preprocessing them.
export const CHILD = `<script lang="ts">
  import Icon from './Icon.ucf'
  import { count } from './count.svelte.js'

  let { label }: { label: string } = $props()
</script>

<button class="child" onclick={() => count.value++}><Icon /> {label}: {count.value}</button>

<style lang="scss">
  // SCSS only: Svelte's own CSS parser rejects this comment and the variable.
  $color: rgb(10, 20, 30);

  .child {
    color: $color;

    &:hover {
      color: rgb(40, 50, 60);
    }
  }
</style>
`;
export const COUNT = 'interface Count {\n  value: number;\n}\n\nexport const count: Count = $state({value: 0});\n';
export const SVELTE_CONFIG =
  "import {vitePreprocess} from '@sveltejs/vite-plugin-svelte';\n\nexport default {preprocess: vitePreprocess()};\n";

export interface BuiltLibrary {
  outDir: string;
  results: LibraryResult[];
  remove: () => Promise<void>;
}

/** A fresh temp out dir per build, so library tests can run in parallel. */
export async function buildFixtureLibrary(root = LIBRARY_DIR, options: LibraryOptions = {}): Promise<BuiltLibrary> {
  await mkdir(TMP_DIR, {recursive: true});
  const outDir = await mkdtemp(join(TMP_DIR, 'library-dist-'));
  try {
    const results = await buildLibrary({...options, root, outDir, vite: {logLevel: 'silent', ...options.vite}});
    return {outDir, results, remove: () => removeLibrary(outDir)};
  } catch (err) {
    await removeLibrary(outDir);
    throw err;
  }
}

/** Each edit is a whole file's content, new or replaced. */
export async function withEditedLibrary(
  edits: {file: string; content: string}[],
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await copyLibrary();
  try {
    for (const {file, content} of edits) {
      const path = join(root, file);
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, content);
    }
    await run(root);
  } finally {
    await removeLibrary(root);
  }
}

export function resultOf(results: LibraryResult[], target: LibraryResult['target']): LibraryResult {
  const result = results.find((entry) => entry.target === target);
  if (!result) throw new Error(`no ${target} build`);
  return result;
}

export function readOutput(result: LibraryResult, file: string): string {
  return readFileSync(join(result.outDir, file), 'utf8');
}

// Their React output starts with `"use client"`: hooks, event handlers or the directive itself.
export const LIBRARY_CLIENT = ['Button', 'Counter', 'Tooltip'];

export function parseOutput(file: string, code: string): ParseResult {
  const parsed = parseSync(file, code, {sourceType: 'module'});
  if (parsed.errors.length > 0) throw new Error(`${file} does not parse: ${parsed.errors[0]!.message}`);
  return parsed;
}

export function specifiersOf(file: string, code: string): string[] {
  const {module} = parseOutput(file, code);
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) => entry.entries.flatMap((exported) => exported.moduleRequest?.value ?? [])),
    ...module.dynamicImports.map((entry) => code.slice(entry.moduleRequest.start + 1, entry.moduleRequest.end - 1)),
  ];
}

/** Every string-literal specifier of a declaration file: imports, re-exports and `import()` types. */
export function typeSpecifiersOf(file: string, code: string): string[] {
  return literalSpecifiers(parseOutput(file, code).program);
}

/** `source` with its one `from`, which must be there, replaced. */
export function edited(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`the fixture has no ${JSON.stringify(from)}`);
  return source.replace(from, to);
}

const require = createRequire(import.meta.url);
const TYPE_CHECKERS = {
  tsc: join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'),
  'vue-tsc': join(dirname(require.resolve('vue-tsc/package.json')), 'bin', 'vue-tsc.js'),
};

/** `fixtures/library-checks/` beside the built packages, so its `../react/…` imports reach them. */
export async function copyLibraryChecks(outDir: string): Promise<string> {
  const checks = join(outDir, 'checks');
  await cp(join(FIXTURES_DIR, 'library-checks'), checks, {recursive: true});
  return checks;
}

/** Resolves with the checker's output, empty when it passed. */
export async function typeCheck(checker: keyof typeof TYPE_CHECKERS, dir: string, project: string): Promise<string> {
  try {
    const {stdout, stderr} = await promisify(execFile)(
      process.execPath,
      [TYPE_CHECKERS[checker], '-p', project, '--pretty', 'false'],
      {cwd: dir}
    );
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const {stdout = '', stderr = ''} = err as {stdout?: string; stderr?: string};
    return `${stdout}${stderr}`.trim() || String(err);
  }
}

// Node strips the types of `@multifront/vite`'s `src/`, which `source` picks.
const BUILD_SCRIPT = `
const {buildLibrary} = await import('@multifront/vite');
await buildLibrary(JSON.parse(process.argv[1])).catch((err) => {
  process.stderr.write(err.message);
  process.exitCode = 1;
});
`;

/** Without pnpm's `NODE_PATH`: an outside library finds only what it installed. Resolves with the error, or ''. */
export async function buildInFreshNode(root: string, options: LibraryOptions): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  const outDir = await mkdtemp(join(TMP_DIR, 'library-dist-'));
  const args = ['--conditions=source', '--input-type=module', '-e', BUILD_SCRIPT, JSON.stringify({...options, root, outDir})];
  try {
    await promisify(execFile)(process.execPath, args, {
      cwd: join(FIXTURES_DIR, '..'),
      env: {...process.env, NODE_PATH: undefined},
    });
    return '';
  } catch (err) {
    return (err as {stderr?: string}).stderr?.trim() || String(err);
  } finally {
    await removeLibrary(outDir);
  }
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs the bin's JS entry, not the `.bin` shim: Windows shims are `.cmd` files that need a shell.
// `source` runs `@multifront/vite`'s `src/`, else its built `dist/`.
export async function runMfBuild(cwd: string, args: string[] = [], {source = true} = {}): Promise<CliRun> {
  const dir = join(FIXTURES_DIR, '..', 'node_modules', '@multifront', 'vite');
  const {bin} = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {bin: Record<string, string>};
  const node = source ? ['--conditions=source'] : [];
  try {
    const {stdout, stderr} = await promisify(execFile)(process.execPath, [...node, join(dir, bin['mf-build']!), ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (err) {
    const {code, stdout = '', stderr = ''} = err as {code?: number | string; stdout?: string; stderr?: string};
    if (typeof code !== 'number') throw err;
    return {code, stdout, stderr};
  }
}
