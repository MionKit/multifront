import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {describe, expect, it} from 'vitest';
import {checkBlocks, getBlockKind, isTarget, loadVueCompiler, locate, splitBlocks, vueSfcCode} from '@multifront/core';
import type {Block} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {readComponent} from '../../../e2e/fixtures/index.ts';

const compiler = loadVueCompiler(import.meta.dirname);

const ONLY_BLANKS = /^[ \r\n]*$/;

// Written by hand from the fixture files; `spots` are texts whose first character the map must trace back.
const CASES: {fixture: string; scriptSetup: boolean; styles: Block['attrs'][]; cssVars: string[]; spots: string[]}[] = [
  {
    fixture: 'Counter.front',
    scriptSetup: true,
    styles: [{scoped: true}, {module: true}],
    cssVars: [],
    spots: ['{{ count }}', 'const count', 'padding'],
  },
  {
    fixture: 'vue/CounterCrlf.front',
    scriptSetup: true,
    styles: [{scoped: true}, {module: true}],
    cssVars: [],
    spots: ['{{ count }}', 'const count', 'padding'],
  },
  {fixture: 'vue/VBind.front', scriptSetup: true, styles: [{scoped: true}], cssVars: ['color'], spots: ['class="bound"']},
  {fixture: 'imports/Icon.front', scriptSetup: true, styles: [{module: true}], cssVars: [], spots: ['$style.icon']},
  // Template only: no script, no style.
  {fixture: 'imports/VueOnly.front', scriptSetup: false, styles: [], cssVars: [], spots: ['Only Vue']},
  // Blanks both a <react> and a <svelte> block.
  {fixture: 'Card.front', scriptSetup: true, styles: [{module: true, lang: 'scss'}], cssVars: [], spots: ['{{ title }}']},
  // A root comment, a <svelte> block and three <style> blocks with multi-line and quoted attributes.
  {
    fixture: 'editor/GrammarEdges.front',
    scriptSetup: true,
    styles: [{module: true, lang: 'scss'}, {lang: 'less'}, {title: 'a lang=scss b'}],
    cssVars: [],
    spots: ['{{ small }}', 'const limit', '.less'],
  },
];

function sfcOf(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  return {filename, source, split, ...vueSfcCode(source, split.blocks, filename)};
}

describe('vueSfcCode', () => {
  describe.each(CASES)('$fixture', ({fixture, scriptSetup, styles, cssVars, spots}) => {
    const {filename, source, split, code, map} = sfcOf(fixture);
    const vue = split.targets.vue!;

    it('keeps the length and every line break of the .front file', () => {
      expect(split.errors).toEqual([]);
      expect(code.length).toBe(source.length);
      expect(code.replace(/[^\r\n]/g, ' ')).toBe(source.replace(/[^\r\n]/g, ' '));
    });

    it('keeps the <vue> content and all text outside the targets in place, and blanks the rest of the targets', () => {
      expect(code.slice(vue.contentStart, vue.contentEnd)).toBe(vue.content);
      expect(code.slice(vue.start, vue.contentStart)).toMatch(ONLY_BLANKS);
      expect(code.slice(vue.contentEnd, vue.end)).toMatch(ONLY_BLANKS);
      const targets = split.blocks.filter((block) => isTarget(block.type));
      for (const block of targets.filter((target) => target !== vue))
        expect(code.slice(block.start, block.end)).toMatch(ONLY_BLANKS);
      // Root <style> blocks, comments and whitespace between blocks.
      const outside = [0, ...targets.flatMap((block) => [block.start, block.end]), source.length];
      for (let index = 0; index < outside.length; index += 2) {
        const [from, to] = [outside[index], outside[index + 1]];
        expect(code.slice(from, to)).toBe(source.slice(from, to));
      }
    });

    it("parses with compiler-sfc as an SFC at the .front file's lines", () => {
      const {descriptor, errors} = compiler.parse(code, {filename});
      expect(errors).toEqual([]);
      expect(descriptor.template?.loc.start.line).toBe(locate(source, source.indexOf('<template')).line);
      expect(descriptor.scriptSetup !== null).toBe(scriptSetup);
      expect(descriptor.script).toBeNull();
      expect(descriptor.styles.map((style) => style.attrs)).toEqual(styles);
      expect(descriptor.styles.map((style) => style.attrs)).toEqual(split.styles.map((style) => style.attrs));
      expect(descriptor.customBlocks).toEqual([]);
      expect(descriptor.cssVars).toEqual(cssVars);
    });

    it.each(spots)('maps %s back to the same line and column of the .front file', (spot) => {
      const offset = source.indexOf(spot);
      expect(offset).toBeGreaterThan(-1);
      const position = locate(code, offset);
      const traced = originalPositionFor(new TraceMap(map), {line: position.line, column: position.column});
      expect(traced).toMatchObject({source: filename, ...locate(source, offset)});
    });
  });

  it('reads CounterCrlf.front as Counter.front with CRLF line breaks', () => {
    expect(readComponent('vue/CounterCrlf.front').source).toBe(readComponent('Counter.front').source.replaceAll('\n', '\r\n'));
  });

  it('blanks a two-unit character in Counter.front as two spaces', () => {
    const {split, code} = sfcOf('Counter.front');
    const react = split.targets.react!;
    expect(react.content).toMatch(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
    expect(code.slice(react.start, react.end)).toMatch(ONLY_BLANKS);
  });

  it('turns a file with no <vue> block into blanks that compiler-sfc rejects', () => {
    const {filename, source, code} = sfcOf('imports/ReactOnly.front');
    expect(code.length).toBe(source.length);
    expect(code).toMatch(ONLY_BLANKS);
    const {descriptor, errors} = compiler.parse(code, {filename});
    expect(descriptor.template).toBeNull();
    expect(descriptor.script).toBeNull();
    expect(descriptor.scriptSetup).toBeNull();
    expect(descriptor.styles).toEqual([]);
    expect(errors.map(String)).toEqual([
      expect.stringContaining('At least one <template> or <script> is required in a single file component.'),
    ]);
  });

  it('keeps only the first <vue> block and blanks a duplicate', () => {
    const {filename, split, code} = sfcOf('vue/DuplicateVue.front');
    expect(split.errors.map(({code}) => code)).toEqual(['duplicate-target']);
    const [first, second] = split.blocks.filter((block) => block.type === 'vue');
    expect(code.slice(first!.contentStart, first!.contentEnd)).toBe(first!.content);
    expect(code.slice(second!.start, second!.end)).toMatch(ONLY_BLANKS);
    const {descriptor, errors} = compiler.parse(code, {filename});
    expect(errors).toEqual([]);
    expect(descriptor.template?.content).toContain('first-vue-block');
    expect(code).not.toContain('second-vue-block');
  });
});

describe('vue.check', () => {
  const check = (name: string) => {
    const {filename, source} = readComponent(name);
    const split = splitBlocks(source, filename);
    return {split, source, diagnostics: getBlockKind('vue').check(split.targets.vue!, split)};
  };

  // Written by hand from the fixture files; the second one's script has no `lang`, so it parses as JavaScript.
  it.each([
    {
      fixture: 'vue/AttrInside.front',
      spots: [
        {line: 3, column: 67},
        {line: 7, column: 49},
      ],
    },
    {fixture: 'vue/AttrInsideJs.front', spots: [{line: 3, column: 49}]},
  ])('reports framework-in-block on each framework attribute of $fixture', ({fixture, spots}) => {
    const {split, source, diagnostics} = check(fixture);
    expect(split.errors).toEqual([]);
    const found = diagnostics.map(({code, line, column, start, end}) => ({code, line, column, text: source.slice(start, end)}));
    expect(found).toEqual(spots.map((spot) => ({code: 'framework-in-block', ...spot, text: "framework: 'vue'"})));
    expect(diagnostics.every(({message}) => message.includes('<vue> block; imports there always get vue'))).toBe(true);
    expect(checkBlocks(split)).toEqual(diagnostics);
  });

  it.each(['Counter.front', 'imports/UsesIcon.front'])(
    'reports nothing for %s, whose <vue> block imports with no attribute',
    (name) => {
      expect(check(name).diagnostics).toEqual([]);
    }
  );
});
