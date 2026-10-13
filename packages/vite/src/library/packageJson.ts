import {existsSync} from 'node:fs';
import {copyFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {LibraryPackageJob} from '../types.ts';

// Order here is the key order in the written package.json.
const COPIED = ['version', 'description', 'license', 'author', 'repository', 'homepage', 'keywords'];
const DOCS = ['README.md', 'LICENSE'];

/** Library metadata, `exports` and peers, nothing else. */
export async function writePackageJson(job: LibraryPackageJob): Promise<void> {
  const {root, outDir, manifest, index, components, componentExt, conditions} = job;
  const typed = (file: string) => existsSync(join(outDir, file));
  // `types` only beside a `.d.ts` that exists: `dts: false` writes none.
  const entry = (file: string, types: string) => ({
    ...(typed(types) && {types: `./${types}`}),
    ...Object.fromEntries(conditions.map((condition) => [condition, `./${file}`])),
  });
  // `Card.js` is typed by `Card.d.ts`, `Card.svelte` by `Card.svelte.d.ts`.
  const typesOf = (name: string) => (componentExt === '.js' ? `${name}.d.ts` : `${name}${componentExt}.d.ts`);
  const exports: Record<string, unknown> = {};
  if (index !== undefined) exports['.'] = entry(`${index}.js`, `${index}.d.ts`);
  for (const name of components) exports[`./${name}`] = entry(`${name}${componentExt}`, typesOf(name));
  // The CSS step always writes `styles.css`, empty when no component has a style.
  Object.assign(exports, {'./styles.css': './styles.css', './*.css': './*.css', './package.json': './package.json'});
  // svelte-package's top-level `svelte` field: a condition beside `default` also names the index.
  const indexFields = index === undefined ? [] : conditions.filter((condition) => condition !== 'default');
  const packageJson = {
    name: job.packageName,
    ...Object.fromEntries(COPIED.filter((key) => manifest[key] != null).map((key) => [key, manifest[key]])),
    type: 'module',
    sideEffects: ['*.css'],
    ...(index !== undefined && typed(`${index}.d.ts`) && {types: `./${index}.d.ts`}),
    ...Object.fromEntries(indexFields.map((condition) => [condition, `./${index}.js`])),
    exports,
    peerDependencies: job.peers,
  };
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const doc of DOCS) if (existsSync(join(root, doc))) await copyFile(join(root, doc), join(outDir, doc));
}
