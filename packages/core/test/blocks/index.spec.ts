import {describe, expect, it} from 'vitest';
import {BLOCK_KINDS, TARGETS, getBlockKind} from '@multifront/core';

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

  // Target kinds get `build` in M3 (react), M4 (vue) and M6 (svelte).
  it('gives only the shared style kind fillContext and build', () => {
    expect(BLOCK_KINDS.filter((kind) => kind.fillContext).map((kind) => kind.tag)).toEqual(['style']);
    expect(BLOCK_KINDS.filter((kind) => kind.build).map((kind) => kind.tag)).toEqual(['style']);
  });

  it('finds each kind by its tag', () => {
    for (const kind of BLOCK_KINDS) expect(getBlockKind(kind.tag)).toBe(kind);
  });
});
