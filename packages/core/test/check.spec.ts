import {describe, expect, it} from 'vitest';
import {checkBlocks, loadVueCompiler, splitBlocks, vueSfcCode} from '@multifront/core';
import type {Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';
import {tsxSyntaxErrors} from './tsx.ts';

function check(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  return {split, diagnostics: checkBlocks(split)};
}

// Written by hand from the fixture files.
const CHECK_CASES: {fixture: string; errors: Pick<Diagnostic, 'code' | 'line' | 'column'>[]}[] = [
  {
    fixture: 'invalid/DuplicateStyleModule.front',
    errors: [
      {code: 'duplicate-style-module', line: 13, column: 0},
      {code: 'duplicate-style-module', line: 19, column: 0},
      {code: 'duplicate-style-module', line: 25, column: 0},
    ],
  },
  // A block error before a splitter error; the second <react> exports `as "default"`.
  {
    fixture: 'invalid/MixedErrors.front',
    errors: [
      {code: 'unknown-style-lang', line: 1, column: 0},
      {code: 'duplicate-target', line: 13, column: 0},
    ],
  },
  // Vue's grammar would color the <style> after it as TSX.
  {fixture: 'invalid/ReactNotLast.front', errors: [{code: 'react-not-last', line: 1, column: 0}]},
  {fixture: 'invalid/ReactNoDefault.front', errors: [{code: 'react-no-default-export', line: 7, column: 0}]},
  // `export type` exports no value, so no runtime default.
  {fixture: 'invalid/ReactTypeOnlyDefault.front', errors: [{code: 'react-no-default-export', line: 7, column: 0}]},
  // `export {type X as default}`, `export default interface` and type-only names export no value either.
  {fixture: 'invalid/ReactTypeOnlyDefaultForms.front', errors: [{code: 'react-no-default-export', line: 7, column: 0}]},
  {fixture: 'invalid/StyleInSvelte.front', errors: [{code: 'style-inside-target', line: 18, column: 2}]},
  {fixture: 'invalid/StyleInVue.front', errors: [{code: 'style-inside-target', line: 17, column: 2}]},
  // Only a comment: no <template> or <script> for Vue to compile.
  {fixture: 'vue/Empty.front', errors: [{code: 'vue-empty-block', line: 1, column: 0}]},
  // Both rules on one block: the opening tag's error first.
  {
    fixture: 'vue/StyleOnlyInVue.front',
    errors: [
      {code: 'vue-empty-block', line: 1, column: 0},
      {code: 'style-inside-target', line: 2, column: 2},
    ],
  },
  {
    fixture: 'invalid/UnknownStyleLang.front',
    errors: [
      {code: 'unknown-style-lang', line: 7, column: 0},
      {code: 'unknown-style-lang', line: 13, column: 0},
    ],
  },
  // No lang, a bare `lang`, a wrong lang.
  {
    fixture: 'invalid/BlockLang.front',
    errors: [
      {code: 'block-lang', line: 1, column: 0},
      {code: 'block-lang', line: 7, column: 0},
      {code: 'block-lang', line: 11, column: 0},
    ],
  },
];
const CHECK_FIXTURES = CHECK_CASES.map((row) => row.fixture);
// <react> blocks TypeScript cannot parse either: the splitter cut one early, the other lacks a brace.
const SYNTAX_FIXTURES = ['invalid/ReactCloseInString.front', 'invalid/ReactSyntaxError.front'];
const VUE_ONLY_STYLE = 'invalid/VueOnlyStyle.front';
const SPLIT_FIXTURES = listComponents('invalid').filter(
  (name) => ![...CHECK_FIXTURES, ...SYNTAX_FIXTURES, VUE_ONLY_STYLE].includes(name)
);

describe('checkBlocks', () => {
  it.each(listComponents())('reports nothing for %s', (name) => {
    expect(check(name).diagnostics).toEqual([]);
  });

  it('takes export {Card as default} as the default export', () => {
    const react = check('ReactDefaultSpecifier.front').split.targets.react;
    expect(react?.content).toContain('export { Card as default }');
    expect(react?.content).not.toContain('export default');
  });

  describe.each(CHECK_CASES)('$fixture', ({fixture, errors}) => {
    const {split, diagnostics} = check(fixture);
    const {source} = split;

    it('reports each rule at its hand-written line and column, in source order', () => {
      expect(diagnostics.map(({code, line, column}) => ({code, line, column}))).toEqual(errors);
    });

    it('points at the opening tag each rule is about, names it, and gives its real position', () => {
      for (const diagnostic of diagnostics) {
        expect(diagnostic.filename).toBe(split.filename);
        expect(diagnostic.message).toMatch(/^<(react|style|svelte|vue)[ >]/);
        expect(source.slice(diagnostic.start, diagnostic.end)).toMatch(/^<(react|style|svelte|vue)(\s[^]*)?>$/);
        const before = source.slice(0, diagnostic.start).split('\n');
        expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
      }
    });

    it('matches the diagnostics snapshot', async () => {
      const table = diagnostics.map((diagnostic) => ({...diagnostic, filename: fixture}));
      await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/check/${fixture}.json`);
    });
  });

  describe(VUE_ONLY_STYLE, () => {
    const {split, diagnostics} = check(VUE_ONLY_STYLE);
    const {source, filename} = split;
    const V_BIND =
      'v-bind() in <style> works in <vue> only, not in <react> or <svelte>; set a CSS variable through the style prop instead';
    const SLOTTED =
      ':slotted() in <style scoped> works in <vue> only, not in <react> or <svelte>; use :deep() or style the content from the parent';

    it('reports each v-bind() and each scoped :slotted() on its own text, never one in a /* */ or // comment or ::slotted()', () => {
      expect(diagnostics.map(({code, line, column, message}) => ({code, line, column, message}))).toEqual([
        {code: 'vue-only-style', line: 25, column: 9, message: V_BIND},
        {code: 'vue-only-style', line: 27, column: 0, message: SLOTTED},
        {code: 'vue-only-style', line: 30, column: 0, message: SLOTTED},
        {code: 'vue-only-style', line: 45, column: 13, message: V_BIND},
        {code: 'vue-only-style', line: 52, column: 10, message: V_BIND},
      ]);
      expect(diagnostics.map(({start, end}) => source.slice(start, end))).toEqual([
        'v-bind(',
        ':slotted(',
        '::v-slotted(',
        'v-bind(',
        'v-bind (',
      ]);
    });

    it('finds the v-bind() expressions compiler-sfc finds in the same styles', () => {
      const {code} = vueSfcCode(source, split.blocks, filename);
      const {descriptor} = loadVueCompiler(import.meta.dirname).parse(code, {filename});
      const bound = diagnostics
        .filter(({message}) => message === V_BIND)
        .map(({end}) => /^\s*([\w$]+)/.exec(source.slice(end))![1]);
      expect(bound).toEqual(['color', 'size', 'size']);
      expect([...new Set(bound)]).toEqual(descriptor.cssVars);
    });

    it('names only the blocks the file has', () => {
      const vueAndReact = source.replace(/<svelte[^]*<\/svelte>/, '');
      const messages = checkBlocks(splitBlocks(vueAndReact, filename)).map(({message}) => message);
      expect(messages[0]).toBe(V_BIND.replace('<react> or <svelte>', '<react>'));
      expect(messages).toHaveLength(5);
    });

    it('reports nothing in a file with only a <vue> block', () => {
      expect(check('vue/VBind.front').diagnostics).toEqual([]);
      const onlyVue = source.replace(/<svelte[^]*<\/svelte>/, '').replace(/<react[^]*<\/react>/, '');
      expect(checkBlocks(splitBlocks(onlyVue, filename))).toEqual([]);
    });
  });

  it.each(SPLIT_FIXTURES)('adds nothing to the splitter errors of %s', (name) => {
    const {split, diagnostics} = check(name);
    expect(diagnostics).toEqual(split.errors);
  });

  it.each(SYNTAX_FIXTURES)('adds only react-syntax-error, inside the block, for %s', (name) => {
    const {split, diagnostics} = check(name);
    const react = split.targets.react!;
    expect(tsxSyntaxErrors(react.content)).not.toEqual([]);
    expect(diagnostics.filter((diagnostic) => split.errors.includes(diagnostic))).toEqual(split.errors);
    const added = diagnostics.filter((diagnostic) => !split.errors.includes(diagnostic));
    expect(added.length).toBeGreaterThan(0);
    for (const {code, start, end} of added) {
      expect(code).toBe('react-syntax-error');
      expect(start).toBeGreaterThanOrEqual(react.contentStart);
      expect(end).toBeLessThanOrEqual(react.contentEnd);
    }
  });
});
