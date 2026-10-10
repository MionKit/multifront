import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

type Workspace = {listPackages: () => {dir: string; private: boolean}[]};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const {listPackages} = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'workspace.mjs')).href)) as Workspace;

// devx's package-list check matches these dirs as text, so a `\` dir from Windows never matches.
describe('listPackages', () => {
  const references = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8');
  const projects = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');

  it.each(listPackages())('$dir is spelled as the root configs spell it', (pkg) => {
    expect(projects).toContain(`'${pkg.dir}/vitest.config.ts'`);
    if (!pkg.private) expect(references).toContain(`./${pkg.dir}/tsconfig.build.json`);
  });
});
