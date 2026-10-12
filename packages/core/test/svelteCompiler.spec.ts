import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadSvelteCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR} from '../../e2e/fixtures/index.ts';

const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');
const SCRIPT = fileURLToPath(new URL('svelteCompiler.child.ts', import.meta.url));
const ENV = {...process.env, NODE_PATH: undefined};

describe('loadSvelteCompiler', () => {
  it('resolves the compiler the project’s svelte ships, from the project root', () => {
    const own = createRequire(join(REPO_ROOT, 'package.json'))('svelte/compiler');
    expect(loadSvelteCompiler(REPO_ROOT)).toBe(own);
  });

  it('parses a Svelte component', () => {
    const ast = loadSvelteCompiler(REPO_ROOT).parse('<p>{title}</p>', {modern: true});
    expect(ast.fragment.nodes.map(({type}) => type)).toEqual(['RegularElement']);
  });

  it('throws from a folder with no Svelte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multifront-no-svelte-'));
    try {
      expect(execFileSync(process.execPath, [SCRIPT, root], {encoding: 'utf8', env: ENV})).toBe(
        'multifront: could not find svelte. Install svelte in your project.'
      );
      expect(execFileSync(process.execPath, [SCRIPT, REPO_ROOT], {encoding: 'utf8', env: ENV})).toBe('found');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('passes on the error of a compiler it found but cannot load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multifront-broken-svelte-'));
    const svelteDir = join(root, 'node_modules', 'svelte');
    try {
      await mkdir(join(svelteDir, 'compiler'), {recursive: true});
      const exports = {'./compiler': './compiler/index.js'};
      await writeFile(join(svelteDir, 'package.json'), JSON.stringify({name: 'svelte', exports}));
      await writeFile(join(svelteDir, 'compiler', 'index.js'), "throw new Error('broken compiler');");
      expect(execFileSync(process.execPath, [SCRIPT, root], {encoding: 'utf8', env: ENV})).toBe('broken compiler');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
