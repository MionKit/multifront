import {describe, expect, it} from 'vitest';
import {
  BLOCK_KINDS,
  DiagnosticsError,
  TARGETS,
  buildTarget,
  checkBlocks,
  createBuildContext,
  getBlockKind,
  loadVueCompiler,
  splitBlocks,
  vueSfcCode,
} from '@multifront/core';
import type {Diagnostic, Target} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, readComponent} from '../../../e2e/fixtures/index.ts';

const compiler = loadVueCompiler(import.meta.dirname);

async function load(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  return {split, ctx: await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: true})};
}

async function buildErrors(name: string, target: Target): Promise<Pick<Diagnostic, 'code' | 'line' | 'column'>[]> {
  const {split, ctx} = await load(name);
  try {
    buildTarget(split, ctx, target);
  } catch (err) {
    expect(err).toBeInstanceOf(DiagnosticsError);
    return (err as DiagnosticsError).diagnostics.map(({code, line, column}) => ({code, line, column}));
  }
  throw new Error(`${name} built as ${target}`);
}

describe('block kinds', () => {
  it('lists the shared kind first, then the targets in TARGETS order', () => {
    expect(BLOCK_KINDS.map((kind) => kind.tag)).toEqual(['style', ...TARGETS]);
    expect(BLOCK_KINDS.map((kind) => kind.role)).toEqual(['shared', 'target', 'target', 'target']);
  });

  // Pins what other tests miss: languageIds and langs no fixture uses.
  it('names the grammar of each kind and style lang', () => {
    const stylus = {scopeName: 'source.stylus', languageId: 'stylus'};
    expect(Object.fromEntries(BLOCK_KINDS.map((kind) => [kind.tag, kind.grammar]))).toEqual({
      style: {
        scopeName: 'source.css',
        languageId: 'css',
        byLang: {
          scss: {scopeName: 'source.css.scss', languageId: 'scss'},
          sass: {scopeName: 'source.sass', languageId: 'sass'},
          less: {scopeName: 'source.css.less', languageId: 'less'},
          styl: stylus,
          stylus,
          postcss: {scopeName: 'source.css.postcss', languageId: 'postcss'},
        },
      },
      vue: {scopeName: 'text.html.vue', languageId: 'vue'},
      react: {scopeName: 'source.tsx', languageId: 'typescriptreact'},
      svelte: {scopeName: 'source.svelte', languageId: 'svelte'},
    });
  });

  it('finds each kind by its tag', () => {
    for (const kind of BLOCK_KINDS) expect(getBlockKind(kind.tag)).toBe(kind);
  });
});

describe('buildTarget', () => {
  it('builds the react row as react.build does', async () => {
    const {split, ctx} = await load('react/AllBlocks.ucf');
    expect(buildTarget(split, ctx, 'react')).toEqual(getBlockKind('react').build!(split.targets.react!, ctx));
  });

  it("throws the react row's check errors at their place", async () => {
    const {split} = await load('react/errors/NoDefault.ucf');
    const [expected] = checkBlocks(split);
    expect(await buildErrors('react/errors/NoDefault.ucf', 'react')).toEqual([
      {code: 'react-no-default-export', line: expected!.line, column: expected!.column},
    ]);
  });

  it('throws missing-target-block for a file without the block', async () => {
    expect(await buildErrors('imports/VueOnly.ucf', 'react')).toEqual([{code: 'missing-target-block', line: 1, column: 0}]);
  });

  it('throws target-not-built for svelte on its opening tag', async () => {
    const {source} = readComponent('react/AllBlocks.ucf');
    const before = source.slice(0, source.indexOf('<svelte>')).split('\n');
    expect(await buildErrors('react/AllBlocks.ucf', 'svelte')).toEqual([
      {code: 'target-not-built', line: before.length, column: before.at(-1)!.length},
    ]);
  });

  it('builds the vue row as the same-length SFC code, mapped to the .ucf file', async () => {
    const {split, ctx} = await load('Counter.ucf');
    expect(buildTarget(split, ctx, 'vue')).toEqual({ext: '.vue', ...vueSfcCode(split.source, split.blocks, split.filename)});
  });

  it('throws vue-empty-block for a <vue> block with no <template> or <script>', async () => {
    expect(await buildErrors('vue/Empty.ucf', 'vue')).toEqual([{code: 'vue-empty-block', line: 1, column: 0}]);
  });
});
