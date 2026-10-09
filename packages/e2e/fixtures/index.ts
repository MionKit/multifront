// Fixture helpers every e2e test uses.
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
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
