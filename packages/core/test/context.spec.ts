import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {classMapId, compileStyles, createBuildContext, getBlockKind, scopeId, splitBlocks, styleId} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, listComponents, readComponent} from '../../e2e/fixtures/index.ts';

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;
const styleKind = getBlockKind('style');

async function context(name: string, production = true) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production});
  return {filename, source, split, ctx};
}

// By hand from the fixture files: `modules` maps each injection name to the block that keeps it.
const FIXTURES: Record<string, {hasScoped: boolean; modules: Record<string, number>}> = {
  'Badge.ucf': {hasScoped: true, modules: {}},
  'Button.ucf': {hasScoped: true, modules: {classes: 1}},
  'Card.ucf': {hasScoped: false, modules: {$style: 0}},
  'ComposesFrom.ucf': {hasScoped: false, modules: {$style: 0}},
  'ComposesScoped.ucf': {hasScoped: true, modules: {$style: 0}},
  'Hello.ucf': {hasScoped: false, modules: {}},
  'Panel.ucf': {hasScoped: true, modules: {}},
  'ReactDefaultSpecifier.ucf': {hasScoped: false, modules: {$style: 0}},
  'TsxEdges.ucf': {hasScoped: true, modules: {}},
};

describe('createBuildContext on valid fixtures', () => {
  it('covers every valid fixture', () => {
    expect(listComponents()).toEqual(Object.keys(FIXTURES));
  });

  describe.each(listComponents())('%s', async (name) => {
    const {filename, source, split, ctx} = await context(name);
    const relativePath = `components/${name}`;

    it('holds the file, its split and its path from the root with / separators', () => {
      expect(ctx.filename).toBe(filename);
      expect(ctx.split).toBe(split);
      expect(ctx.source).toBe(source);
      expect(ctx.production).toBe(true);
      expect(ctx.compiler).toBe(compiler);
      expect(ctx.relativePath).toBe(relativePath);
    });

    it('takes the scope id from scopeId() of the same inputs', () => {
      expect(ctx.scopeId).toBe(scopeId(relativePath, source, true));
    });

    it('compiles every <style> block once, as compileStyles does, with its style module id', async () => {
      const direct = await compileStyles(split.styles, {id: ctx.scopeId, filename, source, compiler, production: true});
      expect(ctx.styles).toEqual(direct);
      ctx.styles.forEach((style, index) => expect(style.id).toBe(styleId(filename, index)));
    });

    it('sets hasScoped and one class map per injection name', () => {
      expect(ctx.hasScoped).toBe(FIXTURES[name]!.hasScoped);
      const modules = Object.entries(FIXTURES[name]!.modules).map(([module, index]) => [
        module,
        {name: module, index, id: classMapId(filename, index), classes: ctx.styles[index]!.classes},
      ]);
      expect(ctx.modules).toEqual(Object.fromEntries(modules));
    });

    it("builds each <style> block into the CSS and map of its compiled style, as '.css'", () => {
      for (const block of split.styles) {
        const {code, map} = ctx.styles[block.index]!;
        expect(styleKind.build!(block, ctx)).toEqual({ext: '.css', code, map});
      }
    });
  });

  it('gives Card.ucf a $style class map with a card class, at its class map module id', async () => {
    const {filename, ctx} = await context('Card.ucf');
    expect(ctx.modules.$style!.id).toBe(`${filename}?ucf&type=style&index=0&module&lang.js`);
    expect(ctx.modules.$style!.classes.card).toBe(`card_${ctx.scopeId}_0`);
  });

  it('gives Hello.ucf no styles, no modules and nothing scoped', async () => {
    const {ctx} = await context('Hello.ucf');
    expect(ctx.styles).toEqual([]);
    expect(ctx.modules).toEqual({});
    expect(ctx.hasScoped).toBe(false);
  });

  it('passes production: false through to scopeId()', async () => {
    const {source, ctx} = await context('Card.ucf', false);
    expect(ctx.production).toBe(false);
    expect(ctx.scopeId).toBe(scopeId('components/Card.ucf', source, false));
    expect(ctx.scopeId).not.toBe(scopeId('components/Card.ucf', source, true));
  });
});

describe('createBuildContext on invalid fixtures', () => {
  it('keeps the class map of a module block that does not compile, empty, and builds no CSS', async () => {
    const {split, ctx} = await context('invalid/ScssSyntaxError.ucf');
    expect(ctx.styles[0]!.errors.map(({code}) => code)).toEqual(['style-compile-error']);
    expect(ctx.modules.$style!.classes).toEqual({});
    expect(styleKind.build!(split.styles[0]!, ctx)).toEqual({ext: '.css', code: '', map: undefined});
  });

  // As in plugin-vue, which merges module names block by block.
  it('gives a repeated module name to the last block that injects it', async () => {
    const {split, ctx} = await context('invalid/DuplicateStyleModule.ucf');
    expect(split.styles.map((block) => block.attrs.module)).toEqual([true, 'classes', true, '', '$style']);
    expect(ctx.modules.$style!.index).toBe(4);
    expect(ctx.modules.classes!.index).toBe(1);
  });
});
