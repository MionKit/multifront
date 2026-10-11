import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import type {Options} from '@vitejs/plugin-vue';
import {createBuildContext, loadVueCompiler, moduleClassName, scopeId, splitBlocks} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {
  build,
  createBuilder,
  mergeConfig,
  type CSSModulesOptions,
  type InlineConfig,
  type PluginOption,
  type Rolldown,
  type ViteDevServer,
} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildCode, exportedScopeId, withDevServer, withNodeEnv} from './lib/build.ts';

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

async function transformImport(server: ViteDevServer, code: string, pattern: RegExp, environment = 'client') {
  const url = [...code.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).find((specifier) => pattern.test(specifier));
  if (!url) throw new Error(`no import matching ${pattern}`);
  return transform(server, url, environment);
}

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

  it('gets the same $style.button class name in dev SSR and in an SSR build', async () => {
    const dev = await withDevServer(vueRoot, {}, async (server) => (await serveVue(server, COUNTER, 1, 'ssr')).module);
    expect(dev).toContain(`"${expected(false).button}"`);
    const {code} = await buildCode(vueRoot, mergeConfig(entry('src/counter-vue.ts'), {build: {ssr: true}}));
    expect(code).toContain(`"${expected(true).button}"`);
  });

  it.each([
    ['one environment per config', {}],
    ['shared plugins', {sharedPlugins: true}],
  ])('gets the same $style.button class name from an app builder with %s', async (_name, options) => {
    const config = mergeConfig(entry('src/counter-vue.ts'), {
      root: vueRoot,
      logLevel: 'silent',
      configLoader: APP_CONFIG_LOADER,
      build: {write: false, minify: false},
      builder: {...options, buildApp: async () => {}},
    });
    const css = await withNodeEnv('production', async () => {
      const builder = await createBuilder(config);
      const output = (await builder.build(builder.environments.client!)) as Rolldown.RolldownOutput;
      return output.output.map((file) => (file.type === 'asset' ? String(file.source) : '')).join('\n');
    });
    expect(classNamed(css, 'button')).toBe(expected(true).button);
  });

  it('gets the same $style.button class name in each rebuild of a watch build', async () => {
    const outDir = join(vueRoot, 'dist-watch');
    const counter = join(vueRoot, COUNTER);
    const edited = source.replace('padding: 4px 12px;', 'padding: 6px 12px;');
    const builds: string[] = [];
    await withNodeEnv('production', async () => {
      const config = mergeConfig(entry('src/counter-vue.ts'), {
        root: vueRoot,
        logLevel: 'silent',
        configLoader: APP_CONFIG_LOADER,
      });
      const watcher = (await build(mergeConfig(config, {build: {watch: {}, outDir, minify: false}}))) as Rolldown.RolldownWatcher;
      try {
        await new Promise<void>((resolve, reject) => {
          watcher.on('event', async (event) => {
            if (event.code === 'ERROR') return reject(event.error);
            if (event.code !== 'BUNDLE_END') return;
            await event.result.close();
            const assets = join(outDir, 'assets');
            const files = (await readdir(assets)).filter((file) => file.endsWith('.css'));
            builds.push((await Promise.all(files.map((file) => readFile(join(assets, file), 'utf8')))).join('\n'));
            if (builds.length === 1) await writeFile(counter, edited);
            else resolve();
          });
        });
      } finally {
        await watcher.close();
        await writeFile(counter, source);
      }
    });
    expect(classNamed(builds[0]!, 'button')).toBe(expected(true).button);
    expect(classNamed(builds[1]!, 'button')).toBe(moduleClassName('button', scopeId(COUNTER, edited, true), 1));
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

const USER_SETTINGS: [string, ComponentIdGenerator, CSSModulesOptions][] = [
  ['nothing set', undefined, {}],
  ["'filepath' and a hashPrefix", 'filepath', {hashPrefix: 'p'}],
  [
    "'filepath-source' and a string pattern with a hashPrefix",
    'filepath-source',
    {generateScopedName: '[local]__[hash:base64:5]', hashPrefix: 'p'},
  ],
  // postcss-modules reads an empty pattern as unset.
  ['an empty pattern', undefined, {generateScopedName: ''}],
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

it('names Plain.vue by a string pattern from the working directory of the moment, as Vite does', async () => {
  // `[path]` is relative to the working directory, which a plugin moves after the config is resolved.
  const cwd = process.cwd();
  const moveCwd: PluginOption = {name: 'move-cwd', buildStart: () => process.chdir(join(vueRoot, 'src'))};
  const plain = (withMultifront: boolean): InlineConfig =>
    mergeConfig(entry('src/Plain.vue'), {
      configFile: false,
      plugins: [vue(), moveCwd, ...(withMultifront ? [multifront()] : [])],
      css: {modules: {generateScopedName: '[path][local]'}},
    });
  try {
    const alone = await buildCode(vueRoot, plain(false));
    process.chdir(cwd);
    expect(classNamed((await buildCode(vueRoot, plain(true))).css, 'note')).toBe(classNamed(alone.css, 'note'));
    expect(classNamed(alone.css, 'note')).toBeDefined();
  } finally {
    process.chdir(cwd);
  }
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

  it('gets the class names core gives it, as Vue, on the dev server', async () => {
    const classes = await composedClasses(false);
    const {module} = await withDevServer(vueRoot, {}, (server) => serveVue(server, COMPOSES, 0));
    for (const names of classes) expect(module).toContain(`"${names}"`);
  });
});

describe("css.transformer: 'lightningcss'", () => {
  it('gives the .ucf module the class names core gives it, as Vue', async () => {
    const {css, code} = await buildCode(vueRoot, mergeConfig(entry('src/counter-vue.ts'), LIGHTNINGCSS));
    expect(classNamed(css, 'button')).toBe(expected(true).button);
    expect(code).toContain(`"${expected(true).button}"`);
    const served = await withDevServer(vueRoot, LIGHTNINGCSS, (server) => serveVue(server, COUNTER, 1));
    expect(classNamed(served.module, 'button')).toBe(expected(false).button);
  });

  it('gives a module that composes from other files the class names core gives it, as Vue', async () => {
    const classes = await composedClasses(true);
    const {code} = await buildCode(vueRoot, mergeConfig(entry('src/composes-vue.ts'), LIGHTNINGCSS));
    for (const names of classes) expect(code).toContain(`"${names}"`);
  });

  it('leaves the React target and Plain.vue as they are without multifront', async () => {
    const {css} = await buildCode(demoRoot, LIGHTNINGCSS);
    expect(classNamed(css, 'button')).toBe(expected(true).button);
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
