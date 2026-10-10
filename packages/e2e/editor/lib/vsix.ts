import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const EXTENSION_DIR = join(REPO_ROOT, 'packages', 'vscode');

// Untyped; keys every entry by its lowercased path.
export const {readZip} = createRequire(import.meta.url)('@vscode/vsce/out/zip.js') as {
  readZip: (path: string, filter: (name: string) => boolean) => Promise<Map<string, Buffer>>;
};

// jszip, which @vscode/test-electron brings: unlike readZip it keeps names as packed (grammars are `*.tmLanguage.json`).
interface ZipEntry {
  dir: boolean;
  async(type: 'nodebuffer'): Promise<Buffer>;
}
const JSZip = createRequire(createRequire(import.meta.url).resolve('@vscode/test-electron'))('jszip') as {
  loadAsync(data: Buffer): Promise<{files: Record<string, ZipEntry>}>;
};

/** A copy of what `pnpm devx vsix` reads, so tests pack without racing over packages/vscode/dist; caller deletes it. */
export function tempRepo(versionJson = '{"version": "0.0.0"}'): string {
  const root = mkdtempSync(join(tmpdir(), 'vsix-'));
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), {recursive: true});
  const generated = new Set(
    ['dist', 'LICENSE', join('node_modules', 'multifront-typescript-plugin-pack')].map((name) => join(EXTENSION_DIR, name))
  );
  // Workspace links are copied as absolute links, so packages resolve to this repo.
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

/** Packs with the real `pnpm devx vsix` in a temp repo and unzips the `.vsix` into `dir`; returns the extension folder. */
export async function packVsix(dir: string): Promise<string> {
  const root = tempRepo();
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'devx.mjs'), 'vsix'], {cwd: root, encoding: 'utf8'});
    if (result.status !== 0) throw new Error(`pnpm devx vsix failed:\n${result.stdout}\n${result.stderr}`);
    await unzipVsix(join(root, 'packages', 'vscode', 'multifront-vscode-0.0.0.vsix'), dir);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
  return join(dir, 'extension');
}

/** Writes the `.vsix` entries under `dir`, as VS Code installs them (`dir/extension/...`). */
async function unzipVsix(vsixPath: string, dir: string): Promise<void> {
  const {files} = await JSZip.loadAsync(readFileSync(vsixPath));
  for (const [name, entry] of Object.entries(files)) {
    if (entry.dir) continue;
    mkdirSync(dirname(join(dir, name)), {recursive: true});
    writeFileSync(join(dir, name), await entry.async('nodebuffer'));
  }
}
