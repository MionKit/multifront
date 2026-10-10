import {cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const EXTENSION_DIR = join(REPO_ROOT, 'packages', 'vscode');

// Untyped; keys every entry by its lowercased path.
export const {readZip} = createRequire(import.meta.url)('@vscode/vsce/out/zip.js') as {
  readZip: (path: string, filter: (name: string) => boolean) => Promise<Map<string, Buffer>>;
};

/**
 * A temp copy of what `pnpm devx vsix` reads, so a test packs without racing others over packages/vscode/dist.
 * Workspace links are copied as absolute links, so packages resolve to this repo; the caller deletes the folder.
 */
export function tempRepo(versionJson = '{"version": "0.0.0"}'): string {
  const root = mkdtempSync(join(tmpdir(), 'vsix-'));
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), {recursive: true});
  const generated = new Set(
    ['dist', 'LICENSE', join('node_modules', 'multifront-typescript-plugin-pack')].map((name) => join(EXTENSION_DIR, name))
  );
  cpSync(EXTENSION_DIR, join(root, 'packages', 'vscode'), {
    recursive: true,
    filter: (path) => !generated.has(path) && !path.endsWith('.vsix'),
  });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
  // The bundler reads packages/vscode/tsconfig.json, which extends it.
  for (const file of ['LICENSE', 'tsconfig.base.json']) cpSync(join(REPO_ROOT, file), join(root, file));
  writeFileSync(join(root, 'version.json'), versionJson);
  return root;
}

/** Writes the `.vsix` entries under `dir`, as VS Code installs them (`dir/extension/...`). */
export async function unzipVsix(vsixPath: string, dir: string): Promise<void> {
  // readZip lowercases names; every shipped path is lowercase except LICENSE.txt, which no test reads.
  for (const [name, content] of await readZip(vsixPath, () => true)) {
    mkdirSync(dirname(join(dir, name)), {recursive: true});
    writeFileSync(join(dir, name), content);
  }
}
