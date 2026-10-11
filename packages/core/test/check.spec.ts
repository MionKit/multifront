import {describe, expect, it} from 'vitest';
import {checkBlocks, splitBlocks} from '@multifront/core';
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
    fixture: 'invalid/DuplicateStyleModule.ucf',
    errors: [
      {code: 'duplicate-style-module', line: 19, column: 0},
      {code: 'duplicate-style-module', line: 25, column: 0},
      {code: 'duplicate-style-module', line: 31, column: 0},
    ],
  },
  // A block error before a splitter error; the second <react> exports `as "default"`.
  {
    fixture: 'invalid/MixedErrors.ucf',
    errors: [
      {code: 'unknown-style-lang', line: 1, column: 0},
      {code: 'duplicate-target', line: 13, column: 0},
    ],
  },
  {fixture: 'invalid/ReactNoDefault.ucf', errors: [{code: 'react-no-default-export', line: 7, column: 0}]},
  // `export type` exports no value, so no runtime default.
  {fixture: 'invalid/ReactTypeOnlyDefault.ucf', errors: [{code: 'react-no-default-export', line: 1, column: 0}]},
  // `export {type X as default}`, `export default interface` and type-only names export no value either.
  {fixture: 'invalid/ReactTypeOnlyDefaultForms.ucf', errors: [{code: 'react-no-default-export', line: 1, column: 0}]},
  {fixture: 'invalid/StyleInSvelte.ucf', errors: [{code: 'style-inside-target', line: 18, column: 2}]},
  {fixture: 'invalid/StyleInVue.ucf', errors: [{code: 'style-inside-target', line: 17, column: 2}]},
  // Only a comment: no <template> or <script> for Vue to compile.
  {fixture: 'vue/Empty.ucf', errors: [{code: 'vue-empty-block', line: 1, column: 0}]},
  {
    fixture: 'invalid/UnknownStyleLang.ucf',
    errors: [
      {code: 'unknown-style-lang', line: 13, column: 0},
      {code: 'unknown-style-lang', line: 19, column: 0},
    ],
  },
];
const CHECK_FIXTURES = CHECK_CASES.map((row) => row.fixture);
// <react> blocks TypeScript cannot parse either: the splitter cut one early, the other lacks a brace.
const SYNTAX_FIXTURES = ['invalid/ReactCloseInString.ucf', 'invalid/ReactSyntaxError.ucf'];
const SPLIT_FIXTURES = listComponents('invalid').filter((name) => ![...CHECK_FIXTURES, ...SYNTAX_FIXTURES].includes(name));

describe('checkBlocks', () => {
  it.each(listComponents())('reports nothing for %s', (name) => {
    expect(check(name).diagnostics).toEqual([]);
  });

  it('takes export {Card as default} as the default export', () => {
    const react = check('ReactDefaultSpecifier.ucf').split.targets.react;
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
        expect(diagnostic.message).toMatch(/^<(react|style|vue)[ >]/);
        expect(source.slice(diagnostic.start, diagnostic.end)).toMatch(/^<(react|style|vue)(\s[^]*)?>$/);
        const before = source.slice(0, diagnostic.start).split('\n');
        expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
      }
    });

    it('matches the diagnostics snapshot', async () => {
      const table = diagnostics.map((diagnostic) => ({...diagnostic, filename: fixture}));
      await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/check/${fixture}.json`);
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
