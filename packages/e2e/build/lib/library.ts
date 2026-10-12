import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {buildLibrary} from '@multifront/vite';
import type {LibraryOptions, LibraryResult} from '@multifront/vite';
import {parseSync} from 'oxc-parser';
import type {ParseResult} from 'oxc-parser';
import {LIBRARY_DIR, TMP_DIR, copyLibrary, removeLibrary} from '../../fixtures/index.ts';

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

// The React components whose output starts with `"use client"`: hooks, event handlers or the directive itself.
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
