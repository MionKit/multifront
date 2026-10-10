import {createRequire} from 'node:module';
import vue from '@vitejs/plugin-vue';
import {checkBlocks, compileStyles, createBuildContext, getBlockKind, splitBlocks} from '@multifront/core';
import type {BuildContext, Diagnostic, VueCompiler} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {build, type Plugin} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, listComponents, readComponent} from '../fixtures/index.ts';

const FIXTURES = [...listComponents(), ...listComponents('invalid')];
const PROBE_ID = 'virtual:build-context';
const styleKind = getBlockKind('style');

interface Loaded {
  name: string;
  source: string;
  diagnostics: Diagnostic[];
  ctx: BuildContext;
}

let loaded: Loaded[];

// What a later host does in a hook: split, check, then build the context with the compiler multifront borrowed.
beforeAll(async () => {
  const collected: Loaded[] = [];
  const plugins = [multifront(), vue()];
  const mf = plugins.find((plugin) => plugin.name === 'multifront')!;
  const probe: Plugin = {
    name: 'probe',
    resolveId: (id) => (id.endsWith(PROBE_ID) ? `\0${PROBE_ID}` : undefined),
    async load(id) {
      if (id !== `\0${PROBE_ID}`) return;
      const {vueCompiler} = mf.api as {vueCompiler: VueCompiler};
      for (const name of FIXTURES) {
        const {filename, source} = readComponent(name);
        const split = splitBlocks(source, filename);
        const diagnostics = checkBlocks(split);
        const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler: vueCompiler, production: true});
        collected.push({name, source, diagnostics, ctx});
      }
      return 'export default 1;';
    },
  };
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [...plugins, probe],
    build: {write: false, lib: {entry: PROBE_ID, formats: ['es']}},
  });
  loaded = collected;
});

describe('split, checkBlocks and createBuildContext inside a real Vite build, on every fixture', () => {
  it('reaches every fixture', () => {
    expect(loaded.map((entry) => entry.name)).toEqual(FIXTURES);
  });

  it('builds the context with the compiler plugin-vue resolved', () => {
    const own = createRequire(import.meta.url)('vue/compiler-sfc');
    for (const {ctx} of loaded) expect(ctx.compiler).toBe(own);
  });

  it.each(FIXTURES)('%s: compiles the styles as a direct compileStyles call does', async (name) => {
    const {ctx} = loaded.find((entry) => entry.name === name)!;
    const {scopeId: id, filename, source, compiler} = ctx;
    expect(ctx.styles).toEqual(await compileStyles(ctx.split.styles, {id, filename, source, compiler, production: true}));
    for (const block of ctx.split.styles) expect(styleKind.build!(block, ctx).code).toBe(ctx.styles[block.index]!.code);
  });

  it.each(FIXTURES)('%s: places every split, check and compile diagnostic at its real line and column', (name) => {
    const {source, diagnostics, ctx} = loaded.find((entry) => entry.name === name)!;
    const all = [...diagnostics, ...ctx.styles.flatMap((style) => style.errors)];
    if (!name.startsWith('invalid/')) expect(all).toEqual([]);
    for (const diagnostic of all) {
      expect(diagnostic.filename).toBe(ctx.filename);
      expect(0 <= diagnostic.start && diagnostic.start <= diagnostic.end && diagnostic.end <= source.length).toBe(true);
      const before = source.slice(0, diagnostic.start).split('\n');
      expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
    }
  });
});
