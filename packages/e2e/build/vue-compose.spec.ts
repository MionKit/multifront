import {createRequire} from 'node:module';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {moduleClassName} from '@multifront/core';
import {getVueCompiler, multifront} from '@multifront/vite';
import {createLogger, createServer, type InlineConfig, type PluginOption} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {scopeAttribute} from '../browser/lib/scope.ts';
import {buildApp, buildCode, rejection} from './lib/build.ts';

let root: string;
// The components beside the copy, not the fixture's own.
const component = (name: string) => join(root, '..', '..', 'components', name);

beforeAll(async () => {
  root = await copyApp('vue');
  return () => removeApp(root);
});

function inline(plugins: PluginOption[], input?: string[]): InlineConfig {
  // An app build drops an entry's exports unless told to keep them.
  const rolldownOptions = {input: input?.map((file) => join(root, file)), preserveEntrySignatures: 'strict' as const};
  const build = input ? {rolldownOptions} : {};
  return {configFile: false, plugins, build};
}

describe('vite build of the vue app', () => {
  it.each([
    ['before', () => ({})],
    ['after', () => inline([multifront(), vue()])],
  ])('plugin-vue listed %s multifront(): the .front files compile as Vue', async (_order, config) => {
    const {code, css} = await buildCode(root, config());
    expect(code).toContain('__name: "Counter"');
    expect(code).toContain('_ctx.$style.button');
    expect(code).toMatch(/__name: "VBind",\s*setup\(__props\) \{\s*useCssVars\(/);
    expect(code).toContain('__name: "Plain"');
    // A <react> block marker.
    expect(code).not.toContain('setCount');
    expect(css).toMatch(/\.counter\[data-v-[0-9a-f]+\]/);
    expect(css).toMatch(/\.bound\[data-v-[0-9a-f]+\] \{\s*color: var\(--/);
  });

  it("keeps the user's own plugin-vue include", async () => {
    const {code} = await buildCode(root, inline([vue({include: [/\.vue$/]}), multifront()], ['index.html']));
    expect(code).toContain('__name: "Plain"');
    expect(code).toContain('__name: "Counter"');
  });

  it("keeps the user's own plugin-vue exclude", async () => {
    const config = inline([vue({exclude: [/VBind\.front$/]}), multifront()], ['index.html']);
    await expect(buildApp(root, config)).rejects.toThrow(/VBind\.front/);
  });

  it('keeps plugin-vue off our style ids when one file is imported as vue and as react', async () => {
    const {code} = await buildCode(root, inline([vue(), multifront()], ['index.html', 'src/bothTargets.ts']));
    expect(code).toContain('__name: "Counter"');
    expect(code).toContain('setCount');
  });

  it('fails a vue pick without plugin-vue, naming the import and its importer', async () => {
    const importer = join(root, 'src', 'bothTargets.ts');
    await expect(buildApp(root, inline([multifront()], ['src/bothTargets.ts']))).rejects.toThrow(
      `../../../components/Counter.front (imported by ${importer}): the vue framework needs @vitejs/plugin-vue in your Vite plugins`
    );
  });
});

// M6's Vue package builds this way: `.front` files as entries, no importer.
describe('a .front entry in a library build with framework: vue', () => {
  // Library build: an app build drops the entry's exports, and the component with them.
  const libraryBuild = (entry: string) =>
    buildCode(root, {
      configFile: false,
      plugins: [vue(), multifront({framework: 'vue'})],
      build: {lib: {entry, formats: ['es'], fileName: 'counter'}, rolldownOptions: {external: ['vue']}},
    });

  it('compiles the <vue> block with plugin-vue: our scope id and $style names, no <react> text', async () => {
    const counter = component('Counter.front');
    const {code, css} = await libraryBuild(counter);
    const scope = scopeAttribute(root, counter, true);
    expect(code).toMatch(/__name: "Counter"/);
    expect(code).toContain('createElementBlock("div"');
    expect(code).not.toContain('useState');
    expect(code).toContain(`["__scopeId", "${scope}"]`);
    expect(css).toContain(`.counter[${scope}]`);
    expect(css).toContain(`.${moduleClassName('button', scope.slice('data-v-'.length), 1)}`);
  });

  it('names the file alone when the entry has no <vue> block', async () => {
    const input = component('imports/ReactOnly.front');
    const err = await rejection<Error>(libraryBuild(input));
    expect(err.message).toContain(`${input} has no <vue> block (missing-target-block)`);
  });
});

it('still compiles the .front file as Vue after a dev server restart with the same plugins', async () => {
  const errors: string[] = [];
  const logger = createLogger('silent');
  logger.error = (message) => void errors.push(message);
  const server = await createServer({
    ...inline([vue(), multifront()]),
    root,
    cacheDir: join(root, '.vite'),
    customLogger: logger,
    server: {middlewareMode: true, ws: false},
    optimizeDeps: {noDiscovery: true},
  });
  try {
    await server.restart();
    const counter = component('Counter.front');
    const result = await server.environments.client.transformRequest(`/@fs${counter}`);
    expect(errors).toEqual([]);
    expect(result?.code).toMatch(/__name: ["']Counter["']/);
    // A restart's `buildStart` must not wrap plugin-vue's compiler twice.
    expect(getVueCompiler(server.config.plugins, root)).toBe(createRequire(import.meta.url)('vue/compiler-sfc'));
  } finally {
    await server.close();
  }
});
