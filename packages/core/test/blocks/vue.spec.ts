import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {describe, expect, it} from 'vitest';
import {isTarget, loadVueCompiler, locate, splitBlocks, vueSfcCode} from '@multifront/core';
import type {Block} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {readComponent} from '../../../e2e/fixtures/index.ts';

const compiler = loadVueCompiler(import.meta.dirname);

const ONLY_BLANKS = /^[ \r\n]*$/;

// Written by hand from the fixture files; `spots` are texts whose first character the map must trace back.
const CASES: {fixture: string; scriptSetup: boolean; styles: Block['attrs'][]; cssVars: string[]; spots: string[]}[] = [
  {
    fixture: 'Counter.ucf',
    scriptSetup: true,
    styles: [{scoped: true}, {module: true}],
    cssVars: [],
    spots: ['{{ count }}', 'const count', 'padding'],
  },
  {
    fixture: 'vue/CounterCrlf.ucf',
    scriptSetup: true,
    styles: [{scoped: true}, {module: true}],
    cssVars: [],
    spots: ['{{ count }}', 'const count', 'padding'],
  },
  {fixture: 'vue/VBind.ucf', scriptSetup: true, styles: [{scoped: true}], cssVars: ['color'], spots: ['class="bound"']},
  {fixture: 'imports/Icon.ucf', scriptSetup: false, styles: [{module: true}], cssVars: [], spots: ['$style.icon']},
  // Blanks both a <react> and a <svelte> block.
  {fixture: 'Card.ucf', scriptSetup: true, styles: [{module: true, lang: 'scss'}], cssVars: [], spots: ['{{ title }}']},
  // A root comment, a <svelte> block and three <style> blocks with multi-line and quoted attributes.
  {
    fixture: 'editor/GrammarEdges.ucf',
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

    it('keeps the length and every line break of the .ucf file', () => {
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

    it("parses with compiler-sfc as an SFC at the .ucf file's lines", () => {
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

    it.each(spots)('maps %s back to the same line and column of the .ucf file', (spot) => {
      const offset = source.indexOf(spot);
      expect(offset).toBeGreaterThan(-1);
      const position = locate(code, offset);
      const traced = originalPositionFor(new TraceMap(map), {line: position.line, column: position.column});
      expect(traced).toMatchObject({source: filename, ...locate(source, offset)});
    });
  });

  it('reads CounterCrlf.ucf as Counter.ucf with CRLF line breaks', () => {
    expect(readComponent('vue/CounterCrlf.ucf').source).toBe(readComponent('Counter.ucf').source.replaceAll('\n', '\r\n'));
  });

  it('blanks a two-unit character in Counter.ucf as two spaces', () => {
    const {split, code} = sfcOf('Counter.ucf');
    const react = split.targets.react!;
    expect(react.content).toMatch(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
    expect(code.slice(react.start, react.end)).toMatch(ONLY_BLANKS);
  });

  it('turns a file with no <vue> block into blanks that compiler-sfc rejects', () => {
    const {filename, source, code} = sfcOf('imports/ReactOnly.ucf');
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
    const {filename, split, code} = sfcOf('vue/DuplicateVue.ucf');
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
