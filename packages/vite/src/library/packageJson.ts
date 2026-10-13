import {existsSync} from 'node:fs';
import {copyFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {LibraryPackageJob} from '../types.ts';

// In this order, each only when the library's own package.json has it.
const COPIED = ['version', 'description', 'license', 'author', 'repository', 'homepage', 'keywords'];
const DOCS = ['README.md', 'LICENSE'];

/** A target package's manifest: the library's metadata, an `exports` map and the row's peers, nothing else. */
export async function writePackageJson(job: LibraryPackageJob): Promise<void> {
  const {root, outDir, manifest, index, components} = job;
  const typed = (name: string) => existsSync(join(outDir, `${name}.d.ts`));
  // `types` only beside a `.d.ts` that exists: `dts: false` writes none.
  const entry = (name: string) => (typed(name) ? {types: `./${name}.d.ts`, default: `./${name}.js`} : {default: `./${name}.js`});
  const exports: Record<string, unknown> = {};
  if (index !== undefined) exports['.'] = entry(index);
  for (const name of components) exports[`./${name}`] = entry(name);
  // The CSS step always writes `styles.css`, empty when no component has a style.
  Object.assign(exports, {'./styles.css': './styles.css', './*.css': './*.css', './package.json': './package.json'});
  const packageJson = {
    name: job.packageName,
    ...Object.fromEntries(COPIED.filter((key) => manifest[key] != null).map((key) => [key, manifest[key]])),
    type: 'module',
    sideEffects: ['*.css'],
    ...(index !== undefined && typed(index) && {types: `./${index}.d.ts`}),
    exports,
    peerDependencies: job.peers,
  };
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const doc of DOCS) if (existsSync(join(root, doc))) await copyFile(join(root, doc), join(outDir, doc));
}
