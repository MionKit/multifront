import {createRequire} from 'node:module';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {parseSync} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {checkBlocks, classMapId, createBuildContext, getBlockKind, splitBlocks, styleId} from '@multifront/core';
import type {Diagnostic, VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, listComponents, readComponent} from '../../../e2e/fixtures/index.ts';
import {isInjected, withoutInjected} from './injected.ts';

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
  // No JSX, so the block also parses as a .ts file: the editor must not read it through the build's rewrite.
  {fixture: 'react/errors/AttrNoJsx.ucf', errors: [{code: IN_BLOCK, line: 5, column: 61, text: 'framework'}]},
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

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;

// Hand-read from the fixtures; `tokens` sit at their .ucf line (1-based) and column (0-based, UTF-16).
// `modules` maps injection name to the <style> index it keeps; `foreign` is text of the other target blocks.
const BUILD_CASES: {
  fixture: string;
  css: number[];
  modules: Record<string, number>;
  tokens: {text: string; line: number; column: number}[];
  directives?: string[];
  foreign?: string[];
}[] = [
  {
    fixture: 'Hello.ucf',
    css: [],
    modules: {},
    tokens: [
      {text: 'Hello(', line: 2, column: 26},
      {text: '{ name: string }', line: 2, column: 42},
      {text: '{name}!', line: 3, column: 21},
    ],
  },
  {
    // `module="my-theme"` is no identifier: its CSS is imported, its class map is not.
    fixture: 'editor/StyleModuleEdges.ucf',
    css: [0, 1, 2, 3],
    modules: {$style: 0, theme: 1, rows: 2},
    tokens: [
      {text: 'StyleModuleEdges(', line: 4, column: 26},
      {text: '$style.card}', line: 6, column: 29},
      {text: "theme['fade-in']", line: 7, column: 25},
    ],
  },
  {
    fixture: 'invalid/DuplicateStyleModule.ucf',
    css: [0, 1, 2, 3, 4],
    modules: {$style: 4, classes: 1},
    tokens: [
      {text: 'DuplicateStyleModule(', line: 2, column: 26},
      {text: '$style.first', line: 3, column: 28},
      {text: 'classes.second', line: 3, column: 44},
    ],
  },
  {
    fixture: 'react/AllBlocks.ucf',
    css: [0, 1, 2],
    modules: {$style: 0, classes: 1},
    tokens: [
      {text: 'AllBlocks(', line: 14, column: 26},
      {text: '$style.card', line: 16, column: 22},
      {text: 'all-blocks-react-marker', line: 18, column: 41},
    ],
    foreign: ['all-blocks-vue-marker', 'all-blocks-svelte-marker', '<script', ':class=', 'class={'],
  },
  {
    fixture: 'react/Directives.ucf',
    css: [0],
    modules: {$style: 0},
    tokens: [
      {text: "'use client'", line: 2, column: 2},
      {text: "'use strict'", line: 3, column: 2},
      {text: '$style.note', line: 6, column: 25},
    ],
    directives: ['use client', 'use strict'],
  },
  {
    // The moved pattern still maps to where it was written.
    fixture: 'react/ScopedBadge.ucf',
    css: [],
    modules: {},
    tokens: [
      {text: 'ScopedBadge(', line: 5, column: 26},
      {text: "{label, className = ''}", line: 5, column: 38},
      {text: '{label}</em>', line: 6, column: 67},
    ],
  },
  {
    fixture: 'react/ScopedPanel.ucf',
    css: [0],
    modules: {},
    tokens: [
      {text: 'ScopedPanel(', line: 4, column: 26},
      // The root's own className, now the first argument of its merge.
      {text: '"panel"', line: 6, column: 25},
      {text: '<ScopedBadge', line: 8, column: 8},
    ],
  },
  {
    fixture: 'react/Unicode.ucf',
    css: [0],
    modules: {$style: 0},
    tokens: [
      {text: '{label}', line: 6, column: 54},
      {text: '<b>', line: 6, column: 62},
      {text: 'énd', line: 6, column: 65},
    ],
  },
  {
    fixture: 'react/UseClient.ucf',
    css: [0],
    modules: {$style: 0},
    tokens: [
      {text: "'use client'", line: 2, column: 2},
      {text: 'useState(0)', line: 7, column: 30},
      {text: '$style.button', line: 9, column: 25},
    ],
    directives: ['use client'],
  },
];

async function build(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: true});
  const block = split.targets.react!;
  return {filename, source, split, ctx, block, diagnostics: react.check(block, split), file: react.build(block, ctx)};
}

describe('react.build', () => {
  it('has a row for every react/ fixture', () => {
    const rows = BUILD_CASES.map((row) => row.fixture).filter((name) => name.startsWith('react/'));
    expect(listComponents('react')).toEqual(rows);
  });

  describe.each(BUILD_CASES)('$fixture', async ({fixture, css, modules, tokens, directives = [], foreign}) => {
    const {filename, source, split, ctx, block, diagnostics, file} = await build(fixture);
    const {program, errors} = parseSync('Block.tsx', file.code, {lang: 'tsx', sourceType: 'module'});
    const injected = program.body.filter(isInjected);

    it('is a valid <react> block, built as a .tsx file that parses', () => {
      expect(diagnostics).toEqual([]);
      expect(file.ext).toBe('.tsx');
      expect(errors).toEqual([]);
    });

    it('matches the code snapshot', async () => {
      const code = file.code.replaceAll(FIXTURES_DIR, '<fixtures>');
      await expect(code).toMatchFileSnapshot(`../__snapshots__/react/build/${fixture}.tsx.snap`);
    });

    it('imports each <style> CSS module in order, then one class map per injection name', () => {
      const found = injected.map((node) => ({names: node.specifiers.map(({local}) => local.name), id: node.source.value}));
      expect(found).toEqual([
        ...css.map((index) => ({names: [], id: styleId(filename, index)})),
        ...Object.entries(modules).map(([name, index]) => ({names: [name], id: classMapId(filename, index)})),
      ]);
    });

    it('adds nothing else: without its imports and stamps the code is the block content', () => {
      const code = withoutInjected(file.code, program);
      expect(ctx.hasScoped ? code.replaceAll(` data-v-${ctx.scopeId}=""`, '') : code).toBe(block.content);
      for (const text of foreign ?? []) {
        expect(source).toContain(text);
        expect(file.code).not.toContain(text);
      }
      expect(split.blocks.some((other) => other.type === 'vue' || other.type === 'svelte')).toBe(foreign !== undefined);
    });

    it('keeps the directive prologue first, before every injected import', () => {
      const prologue = program.body.slice(0, directives.length);
      expect(prologue.map((node) => (node.type === 'ExpressionStatement' ? node.directive : node.type))).toEqual(directives);
      for (const node of injected) expect(node.start).toBeGreaterThan(prologue.at(-1)?.end ?? -1);
    });

    it('maps each marked token back to its line and column in the .ucf file', () => {
      expect(file.map!.sources).toEqual([filename]);
      expect(file.map!.sourcesContent).toEqual([source]);
      const map = new TraceMap(file.map!);
      for (const {text, line, column} of tokens) {
        expect(source.split('\n')[line - 1]!.slice(column).startsWith(text), text).toBe(true);
        const at = file.code.indexOf(text);
        expect(file.code.lastIndexOf(text), text).toBe(at);
        const before = file.code.slice(0, at).split('\n');
        const original = originalPositionFor(map, {line: before.length, column: before.at(-1)!.length});
        expect({text, source: original.source, line: original.line, column: original.column}).toEqual({
          text,
          source: filename,
          line,
          column,
        });
      }
      for (const {
        start,
        source: {value},
      } of injected) {
        const before = file.code.slice(0, start).split('\n');
        expect(originalPositionFor(map, {line: before.length, column: before.at(-1)!.length}).source, value).toBeNull();
      }
    });
  });
});
