import {copyFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {checkBlocks, createBuildContext, getBlockKind, splitBlocks} from '@multifront/core';
import type {BuildContext, SplitResult, VueCompiler} from '@multifront/core';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, listComponents, readComponent} from '../fixtures/index.ts';
import {buildApp} from './lib/build.ts';

// The compiler plugin-vue itself resolves from the app root.
const compiler = createRequire(import.meta.url)('vue/compiler-sfc') as VueCompiler;
const styleKind = getBlockKind('style');

function hasClass(css: string, name: string): boolean {
  return new RegExp(`\\.${name.replace(/[$]/g, '\\$&')}(?![\\w-])`).test(css);
}

/** Both builds get the same plugins, so their CSS passes the same Vite steps; only the entry differs. */
async function buildCss(root: string, entry: string, ctx: BuildContext): Promise<string> {
  const {css} = await buildApp(root, {
    configFile: false,
    plugins: [vue({features: {componentIdGenerator: () => ctx.scopeId}})],
    build: {cssMinify: false, rolldownOptions: {input: join(root, entry)}},
  });
  return css.join('');
}

describe.each(listComponents())('%s, our CSS against plugin-vue after a real Vite build', (name) => {
  const base = name.replace(/\.ucf$/, '');
  let root: string;
  let split: SplitResult;
  let ctx: BuildContext;
  let vueCss: string;
  let oursCss: string;

  beforeAll(async () => {
    const {filename, source} = readComponent(name);
    root = await copyApp('vue-reference');
    await copyFile(filename, join(root, 'src', name));
    split = splitBlocks(source, join(root, 'src', name));
    ctx = await createBuildContext(split, {root, compiler, production: true});

    const plain = split.styles.filter((block) => !('module' in block.attrs));
    const vueSource = ['<template><div /></template>', ...plain.map((block) => source.slice(block.start, block.end))];
    await writeFile(join(root, 'src', `${base}.vue`), vueSource.join('\n'));
    // Joined as Vite joins the CSS modules of a chunk.
    await writeFile(join(root, 'src', `${base}.ours.css`), plain.map((block) => styleKind.build!(block, ctx).code).join(''));
    // Vite drops a scoped block's CSS (cssScopeTo) unless the component is rendered.
    await writeFile(join(root, 'src', 'vue-entry.ts'), `import Component from './${base}.vue';\nconsole.log(Component);\n`);
    await writeFile(join(root, 'src', 'ours-entry.ts'), `import './${base}.ours.css';\n`);

    vueCss = await buildCss(root, 'src/vue-entry.ts', ctx);
    oursCss = await buildCss(root, 'src/ours-entry.ts', ctx);
  });

  afterAll(() => rm(root, {recursive: true, force: true}));

  it('reports nothing', () => {
    expect(checkBlocks(split)).toEqual([]);
    expect(ctx.styles.flatMap((style) => style.errors)).toEqual([]);
  });

  it('emits the CSS plugin-vue emits for the same non-module blocks', () => {
    expect(oursCss).toBe(vueCss);
    const hasPlain = split.styles.some((block) => !('module' in block.attrs));
    if (!hasPlain) return expect(vueCss).toBe('');
    expect(vueCss.trim()).not.toBe('');
    if (ctx.hasScoped) expect(vueCss).toContain(`[data-v-${ctx.scopeId}]`);
  });

  it('maps each module class of the block source to a class of our CSS', () => {
    for (const {index, classes} of Object.values(ctx.modules)) {
      const block = split.styles[index]!;
      const css = styleKind.build!(block, ctx).code;
      expect(Object.keys(classes).length).toBeGreaterThan(0);
      for (const [local, generated] of Object.entries(classes)) {
        expect(hasClass(block.content, local)).toBe(true);
        expect(hasClass(css, generated)).toBe(true);
      }
    }
  });
});
