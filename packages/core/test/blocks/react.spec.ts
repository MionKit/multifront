import {describe, expect, it} from 'vitest';
import {checkBlocks, getBlockKind, splitBlocks} from '@multifront/core';
import type {Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../../e2e/fixtures/index.ts';

const react = getBlockKind('react');
const IN_BLOCK = 'framework-in-block';

function check(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  return {split, source, diagnostics: react.check(split.targets.react!, split)};
}

// Written by hand from the fixture files.
const ERROR_CASES: {fixture: string; errors: (Pick<Diagnostic, 'code' | 'line' | 'column'> & {text: string})[]}[] = [
  {
    fixture: 'react/errors/AttrInBlock.ucf',
    errors: [
      {code: IN_BLOCK, line: 3, column: 45, text: "framework: 'vue'"},
      {code: IN_BLOCK, line: 4, column: 66, text: `"framework": 'react'`},
      {code: IN_BLOCK, line: 5, column: 60, text: "framework: 'svelte'"},
      {code: IN_BLOCK, line: 6, column: 41, text: "framework: 'vue'"},
      {code: IN_BLOCK, line: 12, column: 61, text: "framework: 'vue'"},
      {code: IN_BLOCK, line: 13, column: 63, text: "'framework': pick()"},
      {code: IN_BLOCK, line: 14, column: 65, text: 'framework'},
    ],
  },
  {
    fixture: 'react/errors/AttrNoDefault.ucf',
    errors: [
      {code: 'react-no-default-export', line: 1, column: 0, text: '<react>'},
      {code: IN_BLOCK, line: 2, column: 45, text: "framework: 'vue'"},
    ],
  },
  {fixture: 'react/errors/NamedOnly.ucf', errors: [{code: 'react-no-default-export', line: 1, column: 0, text: '<react>'}]},
  {fixture: 'react/errors/NoDefault.ucf', errors: [{code: 'react-no-default-export', line: 7, column: 0, text: '<react>'}]},
  // Column 38 counts the emoji as two UTF-16 units.
  {fixture: 'react/errors/SyntaxError.ucf', errors: [{code: 'react-syntax-error', line: 4, column: 38, text: 'div'}]},
  {
    fixture: 'react/errors/TwoSyntaxErrors.ucf',
    errors: [
      {code: 'react-syntax-error', line: 3, column: 21, text: 'div'},
      {code: 'react-syntax-error', line: 7, column: 22, text: 'i'},
    ],
  },
];

const DEFAULT_FORMS: {fixture: string; form: string}[] = [
  {fixture: 'react/default-forms/AsDefault.ucf', form: 'export { AsDefault as default }'},
  {fixture: 'react/default-forms/DefaultArrow.ucf', form: 'export default () =>'},
  {fixture: 'react/default-forms/DefaultClass.ucf', form: 'export default class DefaultClass extends Component'},
  {fixture: 'react/default-forms/DefaultFrom.ucf', form: "export { default } from '../../Card.ucf'"},
  {fixture: 'react/default-forms/DefaultFunction.ucf', form: 'export default function DefaultFunction()'},
  {fixture: 'react/default-forms/DefaultIdentifier.ucf', form: 'export default DefaultIdentifier'},
  {fixture: 'react/default-forms/DefaultMemo.ucf', form: 'export default memo(function DefaultMemo()'},
];

describe('react.check', () => {
  it('has a row for every fixture', () => {
    expect(listComponents('react/errors')).toEqual(ERROR_CASES.map((row) => row.fixture));
    expect(listComponents('react/default-forms')).toEqual(DEFAULT_FORMS.map((row) => row.fixture));
  });

  describe.each(ERROR_CASES)('$fixture', ({fixture, errors}) => {
    const {split, source, diagnostics} = check(fixture);

    it('reports each rule at its hand-written line, column and span, in source order', () => {
      expect(split.errors).toEqual([]);
      const found = diagnostics.map(({code, line, column, start, end}) => ({code, line, column, text: source.slice(start, end)}));
      expect(found).toEqual(errors);
    });

    it('gives the line and column of its start offset, in the .ucf file', () => {
      for (const diagnostic of diagnostics) {
        expect(diagnostic.filename).toBe(split.filename);
        const before = source.slice(0, diagnostic.start).split('\n');
        expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
      }
    });

    it('is what checkBlocks, the host call, reports', () => {
      expect(checkBlocks(split)).toEqual(diagnostics);
    });

    it('matches the diagnostics snapshot', async () => {
      const table = diagnostics.map((diagnostic) => ({...diagnostic, filename: fixture}));
      await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(`../__snapshots__/${fixture}.json`);
    });
  });

  it.each(DEFAULT_FORMS)('accepts $fixture as a default export', ({fixture, form}) => {
    const {split, diagnostics} = check(fixture);
    expect(split.errors).toEqual([]);
    expect(split.targets.react!.content).toContain(form);
    expect(diagnostics).toEqual([]);
  });
});
