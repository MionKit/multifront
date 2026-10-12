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
import {FIXTURES_DIR, LIBRARY_DIR, TMP_DIR, copyLibrary, removeLibrary} from '../../fixtures/index.ts';

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
  const parsed = parseSync(file, code, {lang: 'dts', sourceType: 'module'});
  if (parsed.errors.length > 0) throw new Error(`${file} does not parse: ${parsed.errors[0]!.message}`);
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type?: string; value?: unknown}};
    if (node.type !== 'Literal' && node.source?.type === 'Literal' && typeof node.source.value === 'string')
      found.push(node.source.value);
    for (const child of Object.values(node)) visit(child);
  };
  visit(parsed.program);
  return found;
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

/** A real `tsc` / `vue-tsc --noEmit`; resolves with its output, empty when it passed. */
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
