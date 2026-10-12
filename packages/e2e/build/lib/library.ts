import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {buildLibrary} from '@multifront/vite';
import type {LibraryOptions, LibraryResult} from '@multifront/vite';
import {parseSync} from 'oxc-parser';
import {LIBRARY_DIR, TMP_DIR, copyLibrary, removeLibrary} from '../../fixtures/index.ts';

export interface BuiltLibrary {
  outDir: string;
  results: LibraryResult[];
  remove: () => Promise<void>;
}

/** Builds a library into a fresh temp out dir of its own, so library tests can run in parallel. */
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

/** Runs `run` on a fresh copy of the library fixture with `edits` written (a whole file each, new or replaced). */
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

/** Every module specifier of an ES module: imports, re-exports and dynamic imports. */
export function specifiersOf(file: string, code: string): string[] {
  const {module, errors} = parseSync(file, code, {sourceType: 'module'});
  if (errors.length > 0) throw new Error(`${file} does not parse: ${errors[0]!.message}`);
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) => entry.entries.flatMap((exported) => exported.moduleRequest?.value ?? [])),
    ...module.dynamicImports.map((entry) => code.slice(entry.moduleRequest.start + 1, entry.moduleRequest.end - 1)),
  ];
}
