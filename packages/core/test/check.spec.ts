import {describe, expect, it} from 'vitest';
import {checkBlocks, splitBlocks} from '@multifront/core';
import type {Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';

function check(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  return {split, diagnostics: checkBlocks(split)};
}

// Written by hand from the fixture files.
const CHECK_CASES: {fixture: string; errors: Pick<Diagnostic, 'code' | 'line' | 'column'>[]}[] = [
  {fixture: 'invalid/DuplicateStyleModule.ucf', errors: [{code: 'duplicate-style-module', line: 19, column: 0}]},
  {fixture: 'invalid/ReactNoDefault.ucf', errors: [{code: 'react-no-default-export', line: 7, column: 0}]},
  {fixture: 'invalid/StyleInSvelte.ucf', errors: [{code: 'style-inside-target', line: 11, column: 2}]},
  {fixture: 'invalid/StyleInVue.ucf', errors: [{code: 'style-inside-target', line: 14, column: 2}]},
  {fixture: 'invalid/UnknownStyleLang.ucf', errors: [{code: 'unknown-style-lang', line: 13, column: 0}]},
];
const CHECK_FIXTURES = CHECK_CASES.map((row) => row.fixture);
const SPLIT_FIXTURES = listComponents('invalid').filter((name) => !CHECK_FIXTURES.includes(name));

describe('checkBlocks', () => {
  it.each(listComponents())('reports nothing for %s', (name) => {
    expect(check(name).diagnostics).toEqual([]);
  });

  it('takes export {Card as default} as the default export', () => {
    const {split, diagnostics} = check('ReactDefaultSpecifier.ucf');
    expect(split.targets.react?.content).toContain('export { Card as default }');
    expect(split.targets.react?.content).not.toContain('export default');
    expect(diagnostics).toEqual([]);
  });

  describe.each(CHECK_CASES)('$fixture', ({fixture, errors}) => {
    const {split, diagnostics} = check(fixture);

    it('reports its rule at the hand-written line and column', () => {
      expect(diagnostics.map(({code, line, column}) => ({code, line, column}))).toEqual(errors);
    });

    it('points at the opening tag the rule is about, and names it', () => {
      for (const diagnostic of diagnostics) {
        expect(diagnostic.message).toMatch(/^<(react|style)[ >]/);
        const tag = diagnostic.code === 'react-no-default-export' ? 'react' : 'style';
        expect(split.source.slice(diagnostic.start, diagnostic.end)).toMatch(new RegExp(`^<${tag}(\\s[^]*)?>$`));
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

  it('leaves a <react> block that does not parse to the TSX compiler', () => {
    const {split, diagnostics} = check('invalid/ReactCloseInString.ucf');
    expect(split.targets.react).toBeDefined();
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['text-outside-block']);
  });

  it.each([...listComponents(), ...listComponents('invalid')])(
    'gives %s diagnostics in start order, each at its real position',
    (name) => {
      const {split, diagnostics} = check(name);
      const {source} = split;
      expect(diagnostics).toEqual(expect.arrayContaining(split.errors));
      expect(diagnostics.map((diagnostic) => diagnostic.start)).toEqual(
        diagnostics.map((diagnostic) => diagnostic.start).sort((first, second) => first - second)
      );
      for (const diagnostic of diagnostics) {
        expect(diagnostic.severity).toBe('error');
        expect(diagnostic.filename).toBe(split.filename);
        expect(diagnostic.message).not.toMatch(/\n/);
        expect(0 <= diagnostic.start && diagnostic.start <= diagnostic.end && diagnostic.end <= source.length).toBe(true);
        const before = source.slice(0, diagnostic.start).split('\n');
        expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
      }
    }
  );
});
