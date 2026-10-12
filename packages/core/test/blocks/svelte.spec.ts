import {readdirSync} from 'node:fs';
import {sep} from 'node:path';
import {describe, expect, it} from 'vitest';
import {DiagnosticsError, buildTarget, checkBlocks, createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents, readComponent} from '../../../e2e/fixtures/index.ts';

const compiler = loadVueCompiler(import.meta.dirname);
const ERRORS_DIR = 'svelte/errors';

async function svelteBuild(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: true});
  try {
    buildTarget(split, ctx, 'svelte');
  } catch (err) {
    expect(err).toBeInstanceOf(DiagnosticsError);
    return {split, source, thrown: (err as DiagnosticsError).diagnostics};
  }
  throw new Error(`${name} built as svelte`);
}

const rulesOf = (thrown: Diagnostic[]) => thrown.filter(({code}) => code !== 'target-not-built');

const NO_STYLE = '<svelte> uses $style, but no <style module> exists; add one';

// Written by hand from the fixture files.
const ERROR_CASES: {fixture: string; errors: (Pick<Diagnostic, 'code' | 'line' | 'column'> & {text: string})[]}[] = [
  // `$:` and `$$props` are Svelte's own.
  {fixture: `${ERRORS_DIR}/Legacy.ucf`, errors: []},
  // `$style` reads `module="style"` as `$name` reads `module="name"`.
  {fixture: `${ERRORS_DIR}/ModuleNamedStyle.ucf`, errors: []},
  // Every kind of top-level store, `$`-named imports and types, property names, a `style` prop.
  {fixture: `${ERRORS_DIR}/NamedModule.ucf`, errors: []},
  {fixture: `${ERRORS_DIR}/Runes.ucf`, errors: []},
  {fixture: `${ERRORS_DIR}/StyleInHead.ucf`, errors: []},
  // `($style as …)` is a use.
  {
    fixture: `${ERRORS_DIR}/StyleWithoutModule.ucf`,
    errors: [
      {code: 'missing-style-module', line: 3, column: 22, text: '$style'},
      {code: 'missing-style-module', line: 4, column: 22, text: '$style'},
      {code: 'missing-style-module', line: 7, column: 14, text: '$style'},
    ],
  },
  {fixture: `${ERRORS_DIR}/TopLevelStyle.ucf`, errors: [{code: 'style-inside-target', line: 9, column: 2, text: '<style>'}]},
  // Svelte reads `title</h2>` as `title < /h2>…`, a regular expression that never ends.
  {fixture: `${ERRORS_DIR}/UnclosedBrace.ucf`, errors: [{code: 'svelte-parse-error', line: 5, column: 28, text: ''}]},
  // A computed key or member is a use.
  {
    fixture: `${ERRORS_DIR}/WrongModuleName.ucf`,
    errors: [
      {code: 'missing-style-module', line: 3, column: 20, text: '$theme'},
      {code: 'missing-style-module', line: 6, column: 14, text: '$style'},
      {code: 'missing-style-module', line: 7, column: 14, text: '$theme'},
      {code: 'missing-style-module', line: 8, column: 23, text: '$theme'},
    ],
  },
];

describe('the <svelte> rules', () => {
  it('has a row for every fixture', () => {
    expect(listComponents(ERRORS_DIR)).toEqual(ERROR_CASES.map((row) => row.fixture));
  });

  describe.each(ERROR_CASES)('$fixture', async ({fixture, errors}) => {
    const {split, source, thrown} = await svelteBuild(fixture);
    const rules = rulesOf(thrown);
    const block = split.targets.svelte!;

    it('reports each rule at its hand-written line, column and span, in source order', () => {
      expect(split.errors).toEqual([]);
      expect(rules.map(({code, line, column, start, end}) => ({code, line, column, text: source.slice(start, end)}))).toEqual(
        errors
      );
    });

    it('throws target-not-built only when no rule fails', () => {
      if (errors.length > 0) expect(thrown).toEqual(rules);
      else expect(thrown.map(({code}) => code)).toEqual(['target-not-built']);
    });

    it('leaves the compiler rules out of checkBlocks', () => {
      expect(checkBlocks(split)).toEqual(rules.filter(({code}) => code === 'style-inside-target'));
    });

    it('gives the line and column of its start offset, inside the block, with a one-line message', () => {
      for (const diagnostic of rules) {
        expect(diagnostic.filename).toBe(split.filename);
        const before = source.slice(0, diagnostic.start).split('\n');
        expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
        expect(diagnostic.start).toBeGreaterThanOrEqual(block.contentStart);
        expect(diagnostic.end).toBeLessThanOrEqual(block.contentEnd);
        expect(diagnostic.message).toMatch(/^<(svelte|style)> [^\n]+$/);
        expect(diagnostic.message).not.toContain('https://');
      }
    });

    it('matches the diagnostics snapshot', async () => {
      const table = rules.map((diagnostic) => ({...diagnostic, filename: fixture}));
      await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(`../__snapshots__/${fixture}.json`);
    });
  });

  it('names the module, or the store, a $name lacks', async () => {
    const noTheme = '<svelte> uses $theme, but no <style module="theme"> or store named theme exists';
    expect((await svelteBuild(`${ERRORS_DIR}/WrongModuleName.ucf`)).thrown.map(({message}) => message)).toEqual([
      noTheme,
      NO_STYLE,
      noTheme,
      noTheme,
    ]);
    expect((await svelteBuild(`${ERRORS_DIR}/StyleWithoutModule.ucf`)).thrown.map(({message}) => message)).toEqual([
      NO_STYLE,
      NO_STYLE,
      NO_STYLE,
    ]);
  });

  it("passes on Svelte's own parse error text", async () => {
    const [error] = (await svelteBuild(`${ERRORS_DIR}/UnclosedBrace.ucf`)).thrown;
    expect(error!.message).toBe('<svelte> does not parse: Unterminated regular expression');
  });

  // Every other real <svelte> block: only the missing build is left.
  const OTHERS = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.ucf') && !name.startsWith(`${ERRORS_DIR}/`) && !name.startsWith('invalid/'))
    .filter((name) => readComponent(name).source.includes('<svelte>'))
    .sort();

  it('covers the other fixtures with a <svelte> block', () => {
    expect(OTHERS).toEqual(expect.arrayContaining(['Card.ucf', 'react/AllBlocks.ucf', 'editor/GrammarEdges.ucf']));
  });

  it.each(OTHERS)('finds nothing wrong in %s', async (name) => {
    expect((await svelteBuild(name)).thrown.map(({code}) => code)).toEqual(['target-not-built']);
  });
});
