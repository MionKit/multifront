import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import type {Options} from '@vitejs/plugin-vue';
import {createBuildContext, loadVueCompiler, moduleClassName, scopeId, splitBlocks} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {mergeConfig, type CSSModulesOptions, type InlineConfig, type PluginOption, type ViteDevServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {buildCode, exportedScopeId, withDevServer} from './lib/build.ts';

type ComponentIdGenerator = NonNullable<Options['features']>['componentIdGenerator'];

// Both copied apps see the shared components at this path from their root.
const COMPONENTS = '../../components';
const COUNTER = `${COMPONENTS}/Counter.ucf`;
const COMPOSES = `${COMPONENTS}/vue/ComposesFile.ucf`;
const {source} = readComponent('Counter.ucf');
const LIGHTNINGCSS: InlineConfig = {css: {transformer: 'lightningcss'}};

let vueRoot: string;
let demoRoot: string;

beforeAll(async () => {
  vueRoot = await copyApp('vue');
  demoRoot = await copyApp('demo');
  // Entries that pick one target of a component from a `.ts` file.
  for (const [name, component, framework] of [
    ['counter-vue', COUNTER, 'vue'],
    ['composes-vue', COMPOSES, 'vue'],
    ['composes-react', COMPOSES, 'react'],
  ]) {
    const specifier = `../${component}`;
    await writeFile(
      join(vueRoot, 'src', `${name}.ts`),
      `export {default} from '${specifier}' with {framework: '${framework}'};\n`
    );
  }
  return async () => {
    await removeApp(vueRoot);
    await removeApp(demoRoot);
  };
});

function expected(production: boolean) {
  const id = scopeId(COUNTER, source, production);
  return {id, button: moduleClassName('button', id, 1)};
}

/** The `$style` class map core gives `ComposesFile.ucf`: `tag` and `chip` list the names they compose. */
async function composedClasses(production: boolean): Promise<string[]> {
  const file = join(vueRoot, COMPOSES);
  const split = splitBlocks(readComponent('vue/ComposesFile.ucf').source, file);
  const ctx = await createBuildContext(split, {root: vueRoot, compiler: loadVueCompiler(vueRoot), production});
  return Object.values(ctx.modules.$style!.classes);
}

/** An app build drops an entry's exports, and Vite a scoped block's CSS with them. */
function entry(file: string): InlineConfig {
  return {build: {rolldownOptions: {input: join(vueRoot, file), preserveEntrySignatures: 'strict'}}};
}

async function transform(server: ViteDevServer, url: string, environment = 'client'): Promise<string> {
  const result = await server.environments[environment]!.transformRequest(url);
  if (!result) throw new Error(`no module for ${url}`);
  return result.code;
}

/** The first import specifier of `code` that matches `pattern`, transformed. */
async function transformImport(server: ViteDevServer, code: string, pattern: RegExp, environment = 'client') {
  const url = [...code.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).find((specifier) => pattern.test(specifier));
  if (!url) throw new Error(`no import matching ${pattern}`);
  return transform(server, url, environment);
}

/** A `.ucf` module served as Vue, with the `<style module>` request at `index`. */
async function serveVue(server: ViteDevServer, component: string, index: number, environment = 'client') {
  const code = await transform(server, `/@fs${join(vueRoot, component)}`, environment);
  const module = await transformImport(
    server,
    code,
    new RegExp(`[?&]type=style&index=${index}&.*lang\\.module\\.css$`),
    environment
  );
  return {code, module};
}

const counterScopeId = (css: string) => /\.counter\[data-v-([0-9a-f]+)\]/.exec(css)?.[1];
const classNamed = (css: string, local: string) => new RegExp(`\\.([\\w-]*${local}[\\w-]*)\\s*\\{`).exec(css)?.[1];

describe('Counter.ucf as Vue (apps/vue) and as React (apps/demo)', () => {
  it('gets one data-v-* and one $style.button class name in a production build', async () => {
    const {id, button} = expected(true);
    const asVue = await buildCode(vueRoot);
    const asReact = await buildCode(demoRoot);
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
    const asVue = await withDevServer(vueRoot, {}, async (server) => {
      const {code, module} = await serveVue(server, COUNTER, 1);
      return {scopeId: exportedScopeId(code), scoped: await transformImport(server, code, /[?&]type=style&index=0&/), module};
    });
    const asReact = await withDevServer(demoRoot, {}, async (server) => {
      const code = await transform(server, `/@fs${join(demoRoot, COUNTER)}.react.tsx`);
      const scoped = await transformImport(server, code, /[?&]ucf&type=style&index=0&lang\.css$/);
      const moduleCss = await transformImport(server, code, /[?&]ucf&type=style&index=1&lang\.css$/);
      const module = await transformImport(server, code, /[?&]ucf&type=style&index=1&module&lang\.js$/);
      return {code, scoped, moduleCss, module};
    });
    expect(asVue.scopeId).toBe(`data-v-${id}`);
    expect(asReact.code).toContain(`data-v-${id}`);
    expect(counterScopeId(asVue.scoped)).toBe(id);
    expect(counterScopeId(asReact.scoped)).toBe(id);
    // The Vue request holds the CSS and the class map, the React target has a module for each.
    expect(classNamed(asVue.module, 'button')).toBe(button);
    expect(classNamed(asReact.moduleCss, 'button')).toBe(button);
    expect(asVue.module).toContain(`"${button}"`);
    expect(asReact.module).toContain(`"${button}"`);
  });

  it("keeps both after a dev server restart with the same plugins, and leaves the user's css.modules alone", async () => {
    const {id, button} = expected(false);
    const config: InlineConfig = {configFile: false, plugins: [vue(), multifront()], css: {modules: {hashPrefix: 'p'}}};
    const after = await withDevServer(vueRoot, config, async (server) => {
      await server.restart();
      const {code, module} = await serveVue(server, COUNTER, 1);
      // A restart resolves the same inline config again.
      return {scopeId: exportedScopeId(code), module, userModules: server.config.inlineConfig.css?.modules};
    });
    expect(after.scopeId).toBe(`data-v-${id}`);
    expect(classNamed(after.module, 'button')).toBe(button);
    expect(after.userModules).toEqual({hashPrefix: 'p'});
  });
});

// Each row pairs a user componentIdGenerator with a user css.modules setting.
const USER_SETTINGS: [string, ComponentIdGenerator, CSSModulesOptions][] = [
  ['nothing set', undefined, {}],
  ["'filepath' and a hashPrefix", 'filepath', {hashPrefix: 'p'}],
  [
    "'filepath-source' and a string pattern with a hashPrefix",
    'filepath-source',
    {generateScopedName: '[local]__[hash:base64:5]', hashPrefix: 'p'},
  ],
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
  const plain = (withMultifront: boolean): InlineConfig =>
    mergeConfig(entry('src/Plain.vue'), {configFile: false, plugins: plugins(withMultifront), css: {modules}});

  it('builds Plain.vue with the same scope id and module class name as plugin-vue alone', async () => {
    const alone = await buildCode(vueRoot, plain(false));
    const composed = await buildCode(vueRoot, plain(true));
    expect(exportedScopeId(composed.code)).toBe(exportedScopeId(alone.code));
    expect(exportedScopeId(alone.code)).toMatch(/^data-v-/);
    expect(classNamed(composed.css, 'note')).toBe(classNamed(alone.css, 'note'));
    expect(classNamed(alone.css, 'note')).toBeDefined();
  });

  it('serves Plain.vue with the same scope id and module class name as plugin-vue alone', async () => {
    const serve = (withMultifront: boolean) =>
      withDevServer(vueRoot, {configFile: false, plugins: plugins(withMultifront), css: {modules}}, async (server) => {
        const code = await transform(server, '/src/Plain.vue');
        return {
          scopeId: exportedScopeId(code),
          note: classNamed(await transformImport(server, code, /lang\.module\.css$/), 'note'),
        };
      });
    const alone = await serve(false);
    expect(await serve(true)).toEqual(alone);
    expect(alone.scopeId).toMatch(/^data-v-/);
    expect(alone.note).toBeDefined();
  });

  it('keeps the .ucf scope id and class names', async () => {
    const {id, button} = expected(true);
    const {css} = await buildCode(vueRoot, {configFile: false, plugins: plugins(true), css: {modules}});
    expect(counterScopeId(css)).toBe(id);
    expect(classNamed(css, 'button')).toBe(button);
  });
});

it('leaves CSS modules off when the user turned them off', async () => {
  // plugin-vue's <style module> needs CSS modules, so a plain stylesheet shows it.
  await writeFile(join(vueRoot, 'src', 'off.module.css'), '.off {\n  color: red;\n}\n');
  await writeFile(join(vueRoot, 'src', 'off.ts'), "import './off.module.css';\n");
  const config = (withMultifront: boolean): InlineConfig =>
    mergeConfig(entry('src/off.ts'), {
      configFile: false,
      plugins: [vue(), ...(withMultifront ? [multifront()] : [])],
      css: {modules: false},
    });
  const alone = await buildCode(vueRoot, config(false));
  expect((await buildCode(vueRoot, config(true))).css).toBe(alone.css);
  expect(classNamed(alone.css, 'off')).toBe('off');
});

describe('a .ucf module that composes from other files', () => {
  it('gets the class names core gives it, as Vue and as React, in a production build', async () => {
    const classes = await composedClasses(true);
    for (const file of ['src/composes-vue.ts', 'src/composes-react.ts']) {
      const output = await buildCode(vueRoot, entry(file));
      for (const names of classes) expect(output.code).toContain(`"${names}"`);
      expect(classNamed(output.css, 'base')).toBe(classes[0]!.split(' ')[1]);
    }
    expect(classes.join(' ')).toContain('round_');
  });
});

describe("css.transformer: 'lightningcss'", () => {
  it('fails a .ucf <style module> built as Vue, naming the file and the setting', async () => {
    await expect(buildCode(vueRoot, LIGHTNINGCSS)).rejects.toThrow(
      `${join(vueRoot, COUNTER)}: <style module> in the vue target needs css.transformer 'postcss'`
    );
  });

  it('builds Plain.vue as plugin-vue alone does', async () => {
    const plain = (withMultifront: boolean): InlineConfig =>
      mergeConfig(entry('src/Plain.vue'), {
        ...LIGHTNINGCSS,
        configFile: false,
        plugins: [vue(), ...(withMultifront ? [multifront()] : [])],
      });
    const alone = await buildCode(vueRoot, plain(false));
    expect((await buildCode(vueRoot, plain(true))).css).toBe(alone.css);
    expect(classNamed(alone.css, 'note')).toBeDefined();
  });
});
