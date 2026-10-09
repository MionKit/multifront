// Fixture helpers every e2e test uses: component paths and sources, and fresh copies of the fixture apps.
import {readdirSync, readFileSync} from 'node:fs';
import {cp, mkdir, mkdtemp} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

const COMPONENTS_DIR = join(FIXTURES_DIR, 'components');
// Inside the repo, so a copied app still resolves vue, vite and the plugins from the root node_modules.
const TMP_DIR = join(FIXTURES_DIR, '..', '.tmp');

export function componentPath(name: string): string {
  return join(COMPONENTS_DIR, name);
}

export function readComponent(name: string): {filename: string; source: string} {
  const filename = componentPath(name);
  return {filename, source: readFileSync(filename, 'utf8')};
}

// Names keep the folder prefix ('invalid/DuplicateReact.ucf'), so they feed componentPath and readComponent as is.
export function listComponents(folder?: string): string[] {
  return readdirSync(join(COMPONENTS_DIR, folder ?? ''), {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ucf'))
    .map((entry) => (folder ? `${folder}/${entry.name}` : entry.name))
    .sort();
}

export async function copyApp(name: string): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  const root = await mkdtemp(join(TMP_DIR, `${name}-`));
  await cp(join(FIXTURES_DIR, 'apps', name), root, {recursive: true});
  return root;
}
