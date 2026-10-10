import {createRequire} from 'node:module';
import {TraceMap, eachMapping} from '@jridgewell/trace-mapping';
import {describe, expect, it} from 'vitest';
import {compileStyles, scopeId, splitBlocks, styleId} from '@multifront/core';
import type {CompiledStyle, VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;

async function compile(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  const id = scopeId(name, source, true);
  const styles = await compileStyles(split.styles, {id, filename, source, compiler, production: true});
  return {filename, source, split, id, styles};
}

function offsetOf(source: string, line: number, column: number): number {
  return source.split('\n', line - 1).join('\n').length + (line > 1 ? 1 : 0) + column;
}

function token(text: string, offset: number): string {
  return /^[\w.#:%@-]+/.exec(text.slice(offset))?.[0] ?? text.charAt(offset);
}

function hasClass(css: string, name: string): boolean {
  return new RegExp(`\\.${name.replace(/[$]/g, '\\$&')}(?![\\w-])`).test(css);
}

// Written by hand from the fixture files: one row per <style> block.
const STYLE_BLOCKS: Record<string, Pick<CompiledStyle, 'scoped' | 'module'>[]> = {
  'Badge.ucf': [{scoped: true, module: undefined}],
  'Button.ucf': [
    {scoped: true, module: undefined},
    {scoped: false, module: 'classes'},
  ],
  'Card.ucf': [{scoped: false, module: '$style'}],
  'Hello.ucf': [],
  'Panel.ucf': [
    {scoped: true, module: undefined},
    {scoped: false, module: undefined},
  ],
  'ReactDefaultSpecifier.ucf': [{scoped: false, module: '$style'}],
  'TsxEdges.ucf': [{scoped: true, module: undefined}],
};

describe('compileStyles on valid fixtures', () => {
  it('covers every valid fixture', () => {
    expect(listComponents()).toEqual(Object.keys(STYLE_BLOCKS));
  });

  describe.each(listComponents())('%s', async (name) => {
    const {filename, source, split, id, styles} = await compile(name);
    const pairs = styles.map((style, index) => ({style, block: split.styles[index]!}));

    it('compiles each <style> block once, in source order, with its own fields', () => {
      expect(styles.map(({scoped, module}) => ({scoped, module}))).toEqual(STYLE_BLOCKS[name]);
      styles.forEach((style, index) => {
        expect(style.index).toBe(index);
        expect(style.id).toBe(`${filename}?ucf&type=style&index=${index}&lang.css`);
        expect(styleId(filename, index)).toBe(style.id);
        expect(style.errors).toEqual([]);
      });
    });

    it.each(styles.map((style) => style.index))('matches the CSS snapshot of block %i', async (index) => {
      await expect(styles[index]!.code).toMatchFileSnapshot(`__snapshots__/styles/${name}.${index}.css`);
    });

    it('names module classes <local>_<scope id>_<index>, each a class of the block and of the CSS', () => {
      for (const {style, block} of pairs) {
        if (style.module === undefined) {
          expect(style.classes).toBeUndefined();
          continue;
        }
        expect(Object.keys(style.classes!).length).toBeGreaterThan(0);
        for (const [local, generated] of Object.entries(style.classes!)) {
          expect(generated).toBe(`${local}_${id}_${style.index}`);
          expect(hasClass(block.content, local)).toBe(true);
          expect(hasClass(style.code, generated)).toBe(true);
        }
      }
    });

    it('maps every segment into the .ucf file, inside the block it came from', () => {
      for (const {style, block} of pairs) {
        expect(style.map!.sources).toEqual([filename]);
        expect(style.map!.sourcesContent).toEqual([source]);
        const plainCss = block.attrs.lang === undefined || block.attrs.lang === 'css';
        const locals = new Map(Object.entries(style.classes ?? {}).map(([local, generated]) => [`.${generated}`, `.${local}`]));
        const generatedLines = style.code.split('\n');
        let segments = 0;
        eachMapping(new TraceMap(style.map!), (mapping) => {
          if (mapping.originalLine === null) return;
          segments++;
          const original = offsetOf(source, mapping.originalLine, mapping.originalColumn);
          expect(original >= block.contentStart && original < block.contentEnd).toBe(true);
          if (!plainCss) return;
          const generated = token(generatedLines[mapping.generatedLine - 1]!, mapping.generatedColumn);
          expect(locals.get(generated) ?? generated).toBe(token(source, original));
        });
        expect(segments).toBeGreaterThan(0);
      }
    });
  });
});

// Written by hand from the fixture files. `rule` is the text of the error's line, `text` the text it spans:
// a point inside the block, or the opening tag when the error has no place in the block.
const ERROR_CASES = [
  {fixture: 'invalid/ScssSyntaxError.ucf', line: 10, column: 13, rule: '.tag-#{$size {', text: '', tag: '<style lang="scss">'},
  {fixture: 'invalid/CssSyntaxError.ucf', line: 8, column: 0, rule: '.note {', text: '', tag: '<style lang="postcss">'},
  // The error sits in the imported _broken-partial.scss, so its offsets say nothing about the block.
  {
    fixture: 'invalid/ScssPartialError.ucf',
    line: 7,
    column: 0,
    rule: '<style lang="scss">',
    text: '<style lang="scss">',
    tag: '<style lang="scss">',
  },
  {
    fixture: 'invalid/MissingPreprocessor.ucf',
    line: 7,
    column: 0,
    rule: '<style lang="less">',
    text: '<style lang="less">',
    tag: '<style lang="less">',
  },
];

describe('compileStyles on blocks that do not compile', () => {
  it('runs MissingPreprocessor.ucf where less cannot load', () => {
    const require = createRequire(import.meta.url);
    expect(() => require.resolve('less', {paths: [require.resolve('@vue/compiler-sfc')]})).toThrow(/Cannot find module/);
  });

  describe.each(ERROR_CASES)('$fixture', async ({fixture, line, column, rule, text, tag}) => {
    const {filename, source, styles} = await compile(fixture);
    const [style] = styles as [CompiledStyle];

    it('reports one style-compile-error at the hand-written line, column and range', () => {
      expect(style.errors.map(({code, line, column}) => ({code, line, column}))).toEqual([
        {code: 'style-compile-error', line, column},
      ]);
      const [error] = style.errors;
      expect(error!.filename).toBe(filename);
      expect(error!.start).toBe(offsetOf(source, line, column));
      expect(source.slice(error!.start, error!.end)).toBe(text);
      expect(source.split('\n')[line - 1]).toBe(rule);
    });

    it('names the tag in a one-line message and returns no CSS, map or class map', () => {
      expect(style.errors[0]!.message.startsWith(`${tag} does not compile: `)).toBe(true);
      expect(style.errors[0]!.message).not.toMatch(/\n/);
      expect(style.code).toBe('');
      expect(style.map).toBeUndefined();
      expect(style.classes).toBeUndefined();
    });
  });
});
