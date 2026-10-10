import {copyFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {checkBlocks, createBuildContext, getBlockKind, splitBlocks} from '@multifront/core';
import type {BuildContext, SplitResult, VueCompiler} from '@multifront/core';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, listComponents, readComponent} from '../fixtures/index.ts';
import {buildApp} from './lib/build.ts';

const compiler = createRequire(import.meta.url)('vue/compiler-sfc') as VueCompiler;
const styleKind = getBlockKind('style');

async function buildCss(root: string, entry: string, ctx: BuildContext): Promise<string> {
  const {css} = await buildApp(root, {
    configFile: false,
    plugins: [vue({features: {componentIdGenerator: () => ctx.scopeId}})],
    build: {cssMinify: false, rolldownOptions: {input: join(root, entry)}},
  });
  return css.join('');
}

// Style langs checkBlocks accepts, through compileStyles and the style kind's build, against what plugin-vue ships.
describe.each(listComponents('langs'))('%s, a style lang checkBlocks accepts, against plugin-vue', (name) => {
  const base = name.replace(/^langs\/|\.ucf$/g, '');
  let root: string;
  let split: SplitResult;
  let ctx: BuildContext;
  let vueCss: string;
  let oursCss: string;

  beforeAll(async () => {
    const {filename, source} = readComponent(name);
    root = await copyApp('vue-reference');
    await copyFile(filename, join(root, 'src', `${base}.ucf`));
    split = splitBlocks(source, join(root, 'src', `${base}.ucf`));
    ctx = await createBuildContext(split, {root, compiler, production: true});

    const vueSource = ['<template><div /></template>', ...split.styles.map((block) => source.slice(block.start, block.end))];
    await writeFile(join(root, 'src', `${base}.vue`), vueSource.join('\n'));
    await writeFile(
      join(root, 'src', `${base}.ours.css`),
      split.styles.map((block) => styleKind.build!(block, ctx).code).join('')
    );
    await writeFile(join(root, 'src', 'vue-entry.ts'), `import Component from './${base}.vue';\nconsole.log(Component);\n`);
    await writeFile(join(root, 'src', 'ours-entry.ts'), `import './${base}.ours.css';\n`);

    vueCss = await buildCss(root, 'src/vue-entry.ts', ctx);
    oursCss = await buildCss(root, 'src/ours-entry.ts', ctx);
  });

  afterAll(() => rm(root, {recursive: true, force: true}));

  it('passes checkBlocks and compiles with no error', () => {
    expect(checkBlocks(split)).toEqual([]);
    expect(ctx.styles.flatMap((style) => style.errors.map((error) => error.message))).toEqual([]);
  });

  it('emits the CSS plugin-vue emits for the same blocks', () => {
    expect(vueCss).toContain(`[data-v-${ctx.scopeId}]`);
    expect(oursCss).toBe(vueCss);
  });
});
