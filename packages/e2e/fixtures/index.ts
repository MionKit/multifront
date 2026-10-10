import {readdirSync, readFileSync} from 'node:fs';
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
// Inside the repo, so a copied app still resolves vue, vite and the plugins from the root node_modules.
const TMP_DIR = join(FIXTURES_DIR, '..', '.tmp');

export async function copyApp(name: string): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  const root = await mkdtemp(join(TMP_DIR, `${name}-`));
  try {
    await cp(join(FIXTURES_DIR, 'apps', name), root, {recursive: true});
  } catch (err) {
    await rm(root, {recursive: true, force: true});
    throw err;
  }
  return root;
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
