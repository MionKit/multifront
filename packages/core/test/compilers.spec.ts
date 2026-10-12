import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadSvelteCompiler, loadVueCompiler, splitBlocks, stylePreprocessOptions} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, readComponent} from '../../e2e/fixtures/index.ts';

const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');
const SCRIPT = fileURLToPath(new URL('compilers.child.ts', import.meta.url));
const ENV = {...process.env, NODE_PATH: undefined};

const child = (mode: string, root: string) => execFileSync(process.execPath, [SCRIPT, mode, root], {encoding: 'utf8', env: ENV});

describe('loadVueCompiler', () => {
  it('resolves the compiler the project’s vue ships, from the project root', () => {
    const own = createRequire(join(REPO_ROOT, 'package.json'))('vue/compiler-sfc');
    expect(loadVueCompiler(REPO_ROOT)).toBe(own);
  });

  it('gives a sync compileStyle that preprocesses scss as the build does', () => {
    const {filename, source} = readComponent('Card.ucf');
    const [block] = splitBlocks(source, filename).styles;
    const compiler = loadVueCompiler(REPO_ROOT);
    const result = compiler.compileStyle({filename, id: '', source: block!.content, ...stylePreprocessOptions(block!)});
    expect(result.errors).toEqual([]);
    expect(result.code).toBe('.card {\n  padding: 1rem;\n}');
  });

  it('throws from a folder with no Vue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multifront-no-vue-'));
    try {
      expect(child('vue', root)).toBe(
        'Error: multifront: could not find @vue/compiler-sfc. Install vue or @vue/compiler-sfc in your project.'
      );
      expect(child('vue', REPO_ROOT)).toBe('found');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('passes on the error of a compiler it found but cannot load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multifront-broken-vue-'));
    const compilerDir = join(root, 'node_modules', '@vue', 'compiler-sfc');
    try {
      await mkdir(compilerDir, {recursive: true});
      await writeFile(join(compilerDir, 'package.json'), '{"name": "@vue/compiler-sfc", "main": "index.js"}');
      await writeFile(join(compilerDir, 'index.js'), "throw new Error('broken compiler');");
      expect(child('vue', root)).toBe('Error: broken compiler');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('loadSvelteCompiler', () => {
  it('resolves the compiler the project’s svelte ships, from the project root', () => {
    const own = createRequire(join(REPO_ROOT, 'package.json'))('svelte/compiler');
    expect(loadSvelteCompiler(REPO_ROOT)).toBe(own);
  });

  it('throws from a folder with no Svelte, and the svelte build passes that error on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multifront-no-svelte-'));
    const missing = 'Error: multifront: could not find svelte. Install svelte in your project.';
    try {
      expect(child('svelte', root)).toBe(missing);
      expect(child('svelte-build', root)).toBe(missing);
      expect(child('svelte', REPO_ROOT)).toBe('found');
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
      expect(child('svelte', root)).toBe('Error: broken compiler');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
