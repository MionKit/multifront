import {randomUUID} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {cp, mkdir, mkdtemp, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
// Inside the repo, so a copied app still resolves vue, vite and the plugins from the root node_modules.
export const TMP_DIR = join(FIXTURES_DIR, '..', '.tmp');

/** The shared `components/` go where the app's relative imports expect them. */
export async function copyApp(name: string): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  const copy = await mkdtemp(join(TMP_DIR, `${name}-`));
  const root = join(copy, 'apps', name);
  try {
    await cp(join(FIXTURES_DIR, 'apps', name), root, {recursive: true});
    await cp(join(FIXTURES_DIR, 'components'), join(copy, 'components'), {recursive: true});
  } catch (err) {
    await rm(copy, {recursive: true, force: true});
    throw err;
  }
  return root;
}

/** For a file a watcher sees: `writeFile` empties it first, and a watcher reading then gets an empty file. */
export async function saveFile(file: string, source: string): Promise<void> {
  // Outside every app root, so no watcher reports it; same disk as the copies, so the rename is atomic.
  const temp = join(TMP_DIR, `save-${randomUUID()}`);
  await writeFile(temp, source);
  await rename(temp, file);
}

/** Deletes a `copyApp()` copy, the components beside it included. */
export async function removeApp(root: string): Promise<void> {
  const copy = resolve(root, '..', '..');
  if (dirname(copy) !== TMP_DIR) throw new Error(`not a copyApp() copy: ${root}`);
  await rm(copy, {recursive: true, force: true});
}

/** `expected.ts` and the `vite.config.ts` files are no importers. */
export function filesOf(app: string, pattern: RegExp): string[] {
  return readdirSync(join(FIXTURES_DIR, 'apps', app), {recursive: true, encoding: 'utf8'})
    .map((path) => path.split(sep).join('/'))
    .filter((file) => pattern.test(file) && file !== 'expected.ts' && !file.endsWith('vite.config.ts'))
    .sort();
}

/** `'Card.ucf'` or `'invalid/DuplicateReact.ucf'` → its absolute path. */
export function componentPath(name: string): string {
  return join(FIXTURES_DIR, 'components', name);
}

export function readComponent(name: string): {filename: string; source: string} {
  const filename = componentPath(name);
  return {filename, source: readFileSync(filename, 'utf8')};
}

/** Not recursive; names keep the `folder/` prefix. */
export function listComponents(folder?: string): string[] {
  const prefix = folder ? `${folder}/` : '';
  return readdirSync(componentPath(prefix), {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ucf'))
    .map((entry) => prefix + entry.name)
    .sort();
}

/** `name` as a class selector in `css`, not a prefix of a longer one. */
export function hasClass(css: string, name: string): boolean {
  return new RegExp(`\\.${name.replace(/[$]/g, '\\$&')}(?![\\w-])`).test(css);
}

/** `name` as an `@keyframes` name in `css`, not a prefix of a longer one. */
export function hasKeyframes(css: string, name: string): boolean {
  return new RegExp(`@keyframes\\s+${name.replace(/[$]/g, '\\$&')}(?![\\w-])`).test(css);
}
