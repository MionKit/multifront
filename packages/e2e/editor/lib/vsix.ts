import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const EXTENSION_DIR = join(REPO_ROOT, 'packages', 'vscode');
// The installed language-core's global types: the unbundled plugin references them, `pnpm devx vsix` copies them.
const fromLanguageTools = createRequire(createRequire(import.meta.url).resolve('@multifront/language-tools'));
export const LANGUAGE_CORE_TYPES = join(dirname(fromLanguageTools.resolve('@vue/language-core/package.json')), 'types');

// Untyped; keys every entry by its lowercased path.
export const {readZip} = createRequire(import.meta.url)('@vscode/vsce/out/zip.js') as {
  readZip: (path: string, filter: (name: string) => boolean) => Promise<Map<string, Buffer>>;
};

// jszip from @vscode/test-electron: unlike readZip it keeps name case (grammars are `*.tmLanguage.json`).
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

const VSIX_FILE = 'multifront-vscode-0.0.0.vsix';

/** Packs and unzips into `dir/extension/`; the packed file stays as `dir/<VSIX_FILE>`. */
export async function packVsix(dir: string): Promise<string> {
  const root = tempRepo();
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'devx.mjs'), 'vsix'], {cwd: root, encoding: 'utf8'});
    if (result.status !== 0) throw new Error(`pnpm devx vsix failed:\n${result.stdout}\n${result.stderr}`);
    cpSync(join(root, 'packages', 'vscode', VSIX_FILE), join(dir, VSIX_FILE));
    await unzipVsix(join(dir, VSIX_FILE), dir);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
  return join(dir, 'extension');
}

/** The `.vsix` the release workflow packed (`MULTIFRONT_VSIX`), else a fresh pack; unzipped into `dir/extension/`. */
export async function vsixUnderTest(dir: string): Promise<{vsix: string; extension: string}> {
  const given = process.env.MULTIFRONT_VSIX;
  if (!given) return {extension: await packVsix(dir), vsix: join(dir, VSIX_FILE)};
  const vsix = resolve(given);
  if (!existsSync(vsix)) throw new Error(`${vsix} does not exist: run pnpm devx vsix`);
  await unzipVsix(vsix, dir);
  return {vsix, extension: join(dir, 'extension')};
}

/** Same layout VS Code installs: `dir/extension/...`. */
async function unzipVsix(vsixPath: string, dir: string): Promise<void> {
  const {files} = await JSZip.loadAsync(readFileSync(vsixPath));
  for (const [name, entry] of Object.entries(files)) {
    if (entry.dir) continue;
    mkdirSync(dirname(join(dir, name)), {recursive: true});
    writeFileSync(join(dir, name), await entry.async('nodebuffer'));
  }
}
