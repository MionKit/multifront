import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {loadVueCompiler, splitBlocks, stylePreprocessOptions} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, readComponent} from '../../e2e/fixtures/index.ts';

const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');

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
    const script = fileURLToPath(new URL('vueCompiler.child.ts', import.meta.url));
    const env = {...process.env, NODE_PATH: undefined};
    try {
      expect(execFileSync(process.execPath, [script, root], {encoding: 'utf8', env})).toBe(
        'multifront: could not find @vue/compiler-sfc. Install vue or @vue/compiler-sfc in your project.'
      );
      expect(execFileSync(process.execPath, [script, REPO_ROOT], {encoding: 'utf8', env})).toBe('found');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
