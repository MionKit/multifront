import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import type {Options} from '@vitejs/plugin-vue';
import {moduleClassName, scopeId} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {createServer, mergeConfig, type CSSModulesOptions, type InlineConfig, type PluginOption, type ViteDevServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp, exportedScopeId, withNodeEnv} from './lib/build.ts';

type ComponentIdGenerator = NonNullable<Options['features']>['componentIdGenerator'];

// Both copied apps see the shared component at this path from their root.
const COUNTER = '../../components/Counter.ucf';
const {source} = readComponent('Counter.ucf');

let vueRoot: string;
let demoRoot: string;

beforeAll(async () => {
  vueRoot = await copyApp('vue');
  demoRoot = await copyApp('demo');
  return async () => {
    await removeApp(vueRoot);
    await removeApp(demoRoot);
  };
});

function expected(production: boolean) {
  const id = scopeId(COUNTER, source, production);
  return {id, button: moduleClassName('button', id, 1)};
}

async function production(root: string, config: InlineConfig = {}) {
  const {chunks, css} = await buildApp(root, config);
  return {code: chunks.map((chunk) => chunk.code).join('\n'), css: css.join('\n')};
}

/** Uses the app's own `vite.config.ts` unless `config` sets `configFile: false`. */
async function withDevServer<Result>(root: string, config: InlineConfig, run: (server: ViteDevServer) => Promise<Result>) {
  return withNodeEnv('development', async () => {
    const base: InlineConfig = {
      root,
      logLevel: 'silent',
      configLoader: APP_CONFIG_LOADER,
      cacheDir: join(root, '.vite'),
      server: {middlewareMode: true, ws: false},
      // No dep optimizer: when it finishes before transformRequest under load, the request never resolves.
      optimizeDeps: {noDiscovery: true},
    };
    const server = await createServer(mergeConfig(base, config));
    try {
      return await run(server);
    } finally {
      await server.close();
    }
  });
}

async function transform(server: ViteDevServer, url: string): Promise<string> {
  const result = await server.transformRequest(url);
  if (!result) throw new Error(`no module for ${url}`);
  return result.code;
}

/** The first import specifier of `code` that matches `pattern`, transformed. */
async function transformImport(server: ViteDevServer, code: string, pattern: RegExp): Promise<string> {
  const url = [...code.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).find((specifier) => pattern.test(specifier));
  if (!url) throw new Error(`no import matching ${pattern}`);
  return transform(server, url);
}

const counterScopeId = (css: string) => /\.counter\[data-v-([0-9a-f]+)\]/.exec(css)?.[1];
const classNamed = (css: string, local: string) => new RegExp(`\\.([\\w-]*${local}[\\w-]*)\\s*\\{`).exec(css)?.[1];

describe('Counter.ucf as Vue (apps/vue) and as React (apps/demo)', () => {
  it('gets one data-v-* and one $style.button class name in a production build', async () => {
    const {id, button} = expected(true);
    const asVue = await production(vueRoot);
    const asReact = await production(demoRoot);
    expect(counterScopeId(asVue.css)).toBe(counterScopeId(asReact.css));
    expect(counterScopeId(asVue.css)).toBe(id);
    expect(asVue.code).toMatch(new RegExp(`["']__scopeId["']\\s*,\\s*["']data-v-${id}["']`));
    expect(asReact.code).toContain(`data-v-${id}`);
    expect(classNamed(asVue.css, 'button')).toBe(classNamed(asReact.css, 'button'));
    expect(classNamed(asVue.css, 'button')).toBe(button);
    expect(asVue.code).toContain(`"${button}"`);
    expect(asReact.code).toContain(`"${button}"`);
  });

  it('gets one data-v-* and one $style.button class name on the dev server', async () => {
    const {id, button} = expected(false);
    const counter = `/@fs${join(vueRoot, COUNTER)}`;
    const asVue = await withDevServer(vueRoot, {}, async (server) => {
      const code = await transform(server, counter);
      const scoped = await transformImport(server, code, /[?&]type=style&index=0&/);
      const module = await transformImport(server, code, /[?&]type=style&index=1&.*lang\.module\.css$/);
      return {scopeId: exportedScopeId(code), scoped, module};
    });
    const asReact = await withDevServer(demoRoot, {}, async (server) => {
      const code = await transform(server, `/@fs${join(demoRoot, COUNTER)}.react.tsx`);
      const scoped = await transformImport(server, code, /[?&]ucf&type=style&index=0&lang\.css$/);
      const module = await transformImport(server, code, /[?&]ucf&type=style&index=1&module&lang\.js$/);
      return {code, scoped, module};
    });
    expect(asVue.scopeId).toBe(`data-v-${id}`);
    expect(asReact.code).toContain(`data-v-${id}`);
    expect(counterScopeId(asVue.scoped)).toBe(id);
    expect(counterScopeId(asReact.scoped)).toBe(id);
    expect(asVue.module).toContain(`"${button}"`);
    expect(asReact.module).toContain(`"${button}"`);
  });

  it('keeps both after a dev server restart with the same plugins', async () => {
    const {id, button} = expected(false);
    const config: InlineConfig = {configFile: false, plugins: [vue(), multifront()]};
    const after = await withDevServer(vueRoot, config, async (server) => {
      await server.restart();
      const code = await transform(server, `/@fs${join(vueRoot, COUNTER)}`);
      return {scopeId: exportedScopeId(code), module: await transformImport(server, code, /lang\.module\.css$/)};
    });
    expect(after.scopeId).toBe(`data-v-${id}`);
    expect(after.module).toContain(`"${button}"`);
  });
});

// Each row pairs a user componentIdGenerator with a user css.modules setting.
const USER_SETTINGS: [string, ComponentIdGenerator, CSSModulesOptions][] = [
  ['nothing set', undefined, {}],
  ["'filepath' and a hashPrefix", 'filepath', {hashPrefix: 'p'}],
  ["'filepath-source' and a string pattern", 'filepath-source', {generateScopedName: '[local]__[hash:base64:5]'}],
  [
    'functions',
    (path, text) => `f${path.length}${text.length}`,
    {generateScopedName: (local, filename) => `${local}-${filename.length}`},
  ],
];

describe.each(USER_SETTINGS)('with %s in the user config', (_name, componentIdGenerator, modules) => {
  const plugins = (withMultifront: boolean): PluginOption[] => [
    vue({features: {componentIdGenerator}}),
    ...(withMultifront ? [multifront()] : []),
  ];
  // An app build drops an entry's exports, and Vite a scoped block's CSS with them.
  const plain = (withMultifront: boolean): InlineConfig => ({
    configFile: false,
    plugins: plugins(withMultifront),
    css: {modules},
    build: {rolldownOptions: {input: join(vueRoot, 'src/Plain.vue'), preserveEntrySignatures: 'strict'}},
  });

  it('builds Plain.vue with the same scope id and module class name as plugin-vue alone', async () => {
    const alone = await production(vueRoot, plain(false));
    const composed = await production(vueRoot, plain(true));
    expect(exportedScopeId(composed.code)).toBe(exportedScopeId(alone.code));
    expect(exportedScopeId(alone.code)).toMatch(/^data-v-/);
    expect(classNamed(composed.css, 'note')).toBe(classNamed(alone.css, 'note'));
    expect(classNamed(alone.css, 'note')).toBeDefined();
  });

  it('serves Plain.vue with the same scope id as plugin-vue alone', async () => {
    const serve = (withMultifront: boolean) =>
      withDevServer(vueRoot, {configFile: false, plugins: plugins(withMultifront)}, async (server) =>
        exportedScopeId(await transform(server, '/src/Plain.vue'))
      );
    const alone = await serve(false);
    expect(await serve(true)).toBe(alone);
    expect(alone).toMatch(/^data-v-/);
  });

  it('keeps the .ucf scope id and class names', async () => {
    const {id, button} = expected(true);
    const {css} = await production(vueRoot, {configFile: false, plugins: plugins(true), css: {modules}});
    expect(counterScopeId(css)).toBe(id);
    expect(classNamed(css, 'button')).toBe(button);
  });
});
