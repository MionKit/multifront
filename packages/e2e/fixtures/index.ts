import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {cp, mkdir, mkdtemp, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve, sep} from 'node:path';
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

/** Not a workspace package: its tools resolve from the repo's node_modules. */
export const LIBRARY_DIR = join(FIXTURES_DIR, 'library');

/** A copy to edit; `removeLibrary()` deletes it. */
export async function copyLibrary(): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  const root = await mkdtemp(join(TMP_DIR, 'library-'));
  // Not its `node_modules`: the type stages of library builds running in parallel live there.
  await cp(LIBRARY_DIR, root, {recursive: true, filter: (source) => basename(source) !== 'node_modules'});
  return root;
}

const OUTSIDE_PREFIX = 'mf-library-';
// The repo's installed packages, then the e2e package's own (the workspace packages).
const INSTALLED = [join(FIXTURES_DIR, '..', '..', '..', 'node_modules'), join(FIXTURES_DIR, '..', 'node_modules')];

function packagesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => (name.startsWith('@') ? readdirSync(join(dir, name)).map((scoped) => `${name}/${scoped}`) : [name]));
}

/** Outside the workspace so nothing resolves from above it; `without` = packages the library never installed. */
export async function copyLibraryOutside(without: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), OUTSIDE_PREFIX));
  try {
    await cp(LIBRARY_DIR, root, {recursive: true, filter: (source) => basename(source) !== 'node_modules'});
    const modules = join(root, 'node_modules');
    for (const dir of INSTALLED) {
      for (const name of packagesIn(dir)) {
        const link = join(modules, name);
        if (without.includes(name) || existsSync(link)) continue;
        await mkdir(dirname(link), {recursive: true});
        // A junction needs no rights on Windows; elsewhere the type is ignored.
        await symlink(join(dir, name), link, 'junction');
      }
    }
  } catch (err) {
    await rm(root, {recursive: true, force: true});
    throw err;
  }
  return root;
}

/** A `copyLibrary()` or `copyLibraryOutside()` copy, or a temp out dir beside the first. */
export async function removeLibrary(root: string): Promise<void> {
  const outside = dirname(root) === tmpdir() && basename(root).startsWith(OUTSIDE_PREFIX);
  if (dirname(root) !== TMP_DIR && !outside) throw new Error(`not a temp library folder: ${root}`);
  await rm(root, {recursive: true, force: true});
}

/** Not `writeFile`: it empties the file first, so a watcher reading mid-write sees it empty. */
export async function saveFile(file: string, source: string): Promise<void> {
  // Outside every app root so no watcher sees it; on the copies' disk so the rename is atomic.
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

/** Every string-literal specifier in a parsed tree: imports, re-exports, `import()` and `import()` types. */
export function literalSpecifiers(tree: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type?: string; value?: unknown}};
    if (node.type !== 'Literal' && node.source?.type === 'Literal' && typeof node.source.value === 'string')
      found.push(node.source.value);
    for (const child of Object.values(node)) visit(child);
  };
  visit(tree);
  return found;
}
