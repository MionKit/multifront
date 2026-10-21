import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {TraceMap, eachMapping, type SourceMapInput} from '@jridgewell/trace-mapping';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {multifront} from '@multifront/vite';
import type {InlineConfig, Rolldown, ViteDevServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {buildApp, componentContext, rejection, withDevServer} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'svelte-vite');
const MAIN = join(ROOT, 'src', 'main.ts');
const COMPONENTS = ['Panel.ucf', 'PanelItem.ucf', 'Counter.ucf'];
const SVELTE_MARKERS = ['panel-svelte-marker', 'panel-item-svelte-marker'];
// Panel's own <vue> and <react> blocks carry no marker.
const OTHER_MARKERS = ['panel-item-vue-marker', 'panel-item-react-marker'];
const SVELTE_ID = (name: string) => `${componentPath(name)}.svelte.svelte`;

const contextOf = (name: string) => componentContext(ROOT, name);

function expectPanelMappings(map: SourceMapInput): void {
  const {source} = readComponent('Panel.ucf');
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const lines: number[] = [];
  eachMapping(new TraceMap(map), (mapping) => {
    // Dev maps name the source relative to the module, beside it; build maps relative to the output.
    if (/(?:^|\/)Panel\.ucf$/.test(mapping.source ?? '')) lines.push(mapping.originalLine!);
  });
  expect(lines.length).toBeGreaterThan(0);
  const svelte = source.indexOf('<svelte lang="html">');
  for (const line of lines) expect(line).toBeGreaterThanOrEqual(lineOf(svelte));
  for (const line of lines) expect(line).toBeLessThanOrEqual(lineOf(source.indexOf('</svelte>')));
  // The React block holds `{heading}` too, after the Svelte block.
  expect(lines).toContain(lineOf(source.indexOf('{heading}', svelte)));
}

describe('vite build of svelte-vite', () => {
  let chunk: Rolldown.OutputChunk;
  let css: string[];

  beforeAll(async () => {
    const result = await buildApp(ROOT, {build: {sourcemap: true}});
    expect(result.chunks).toHaveLength(1);
    chunk = result.chunks[0]!;
    css = result.css;
  });

  it('bundles the compiled Svelte module of each component, PanelItem reached from Panel with no attribute', () => {
    for (const name of COMPONENTS) {
      const id = SVELTE_ID(name);
      expect(chunk.moduleIds).toContain(id);
      const code = chunk.modules[id]!.code!;
      for (const raw of ['<script', '{@render', '$props()', '{heading}', '{label}'])
        expect(code, `${name} ${raw}`).not.toContain(raw);
    }
    expect(chunk.moduleIds.some((id) => /\/svelte\/src\/internal\/client\//.test(id))).toBe(true);
    for (const marker of SVELTE_MARKERS) expect(chunk.code).toContain(marker);
  });

  it("stamps Panel's compiled template with its production scope id", async () => {
    const ctx = await contextOf('Panel.ucf');
    expect(chunk.modules[SVELTE_ID('Panel.ucf')]!.code).toContain(`data-v-${ctx.scopeId}=""`);
  });

  it('puts each style block once in the one CSS asset, each class map in the bundle, and no Svelte CSS', async () => {
    expect(css).toHaveLength(1);
    for (const name of COMPONENTS) {
      const ctx = await contextOf(name);
      expect(ctx.styles.length).toBeGreaterThan(0);
      for (const style of ctx.styles) {
        const selector = style.code.slice(0, style.code.indexOf('{')).trim();
        expect(css[0]!.split(selector).length - 1, `${name} ${selector}`).toBe(1);
        for (const generated of Object.values(style.classes ?? {})) expect(chunk.code).toContain(JSON.stringify(generated));
      }
    }
    expect(css[0]).not.toMatch(/\.svelte-[\w-]+/);
  });

  it('leaves out the text of the <vue> and <react> blocks', () => {
    for (const marker of OTHER_MARKERS) for (const text of [chunk.code, ...css]) expect(text).not.toContain(marker);
  });

  it("maps the compiled Panel back into Panel.ucf's <svelte> block", () => {
    expectPanelMappings(chunk.map!.toString());
  });
});

/** plugin-svelte pre-bundles svelte, so its cache stays out of the fixture app. */
async function withSvelteDevServer(config: InlineConfig, run: (server: ViteDevServer) => Promise<void>): Promise<void> {
  await mkdir(TMP_DIR, {recursive: true});
  const cacheDir = await mkdtemp(join(TMP_DIR, 'svelte-vite-cache-'));
  try {
    await withDevServer(ROOT, {...config, cacheDir}, run);
  } finally {
    await rm(cacheDir, {recursive: true, force: true});
  }
}

async function panelModule(server: ViteDevServer, environment: 'client' | 'ssr') {
  const main = await server.environments[environment].transformRequest('/src/main.ts');
  // Client code imports it `from "<url>"`, SSR code through `__vite_ssr_import__("<url>")`.
  const url = /"([^"]+Panel\.ucf\.svelte\.svelte)"/.exec(main!.code)?.[1];
  expect(url).toBeDefined();
  return {url: url!, result: (await server.environments[environment].transformRequest(url!))!};
}

describe('dev server of svelte-vite', () => {
  it('serves the compiled Panel module at the URL main.ts imports, mapped into Panel.ucf and watching it', async () => {
    await withSvelteDevServer({}, async (server) => {
      const {url, result} = await panelModule(server, 'client');
      expect(result.code).toMatch(/from "[^"]*svelte[/_]internal[/_]client/);
      expectPanelMappings(result.map as SourceMapInput);
      const module = await server.environments.client.moduleGraph.getModuleByUrl(url);
      expect(module?.id).toBe(SVELTE_ID('Panel.ucf'));
      expect([...module!.importedModules].map(({id}) => id)).toContain(componentPath('Panel.ucf'));
    });
  });

  it('serves the server-compiled Panel module to SSR, mapped into Panel.ucf', async () => {
    await withSvelteDevServer({}, async (server) => {
      const {result} = await panelModule(server, 'ssr');
      // `svelte/internal/server` comes pre-bundled (`svelte_internal_server.js`) or, on plugin-svelte 7.0, as its source.
      expect(result.code).toMatch(/svelte(?:\/src)?[/_]internal[/_]server/);
      expectPanelMappings(result.map as SourceMapInput);
    });
  });

  it("wraps plugin-svelte's compile and hot update once across a restart with the same plugins", async () => {
    const plugins = [svelte(), multifront()];
    const pluginNamed = (name: string) => plugins.flat().find((plugin) => plugin.name === name)!;
    const compile = pluginNamed('vite-plugin-svelte:compile');
    const hotUpdate = pluginNamed('vite-plugin-svelte:hot-update');
    const handlersOf = () => [compile.transform, hotUpdate.hotUpdate].map((hook) => (hook as {handler: unknown}).handler);
    await withSvelteDevServer({configFile: false, plugins}, async (server) => {
      const wrapped = handlersOf();
      await server.restart();
      expect(handlersOf()).toEqual(wrapped);
      expectPanelMappings((await panelModule(server, 'client')).result.map as SourceMapInput);
    });
  });

  it('answers a request for the Svelte id, with no plugin-svelte in the app, with the plugin-svelte error', async () => {
    await withSvelteDevServer({configFile: false, plugins: [multifront()]}, async (server) => {
      const id = SVELTE_ID('Panel.ucf');
      await expect(server.environments.client.transformRequest(id)).rejects.toThrow(
        `${id}: the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins`
      );
    });
  });
});

describe('vite build of svelte-vite without a working plugin-svelte', () => {
  const build = (plugins: InlineConfig['plugins']) =>
    rejection<Error>(buildApp(ROOT, {configFile: false, plugins, build: {rolldownOptions: {input: MAIN}}}));

  it('fails with our message, naming the import, its importer and the Svelte id, when plugin-svelte is missing', async () => {
    const err = await build([multifront()]);
    // Panel and Counter resolve in parallel: either one fails first.
    const name = /components\/(Panel|Counter)\.ucf \(imported by/.exec(err.message)?.[1];
    expect(name).toBeDefined();
    expect(err.message).toContain(
      `../../../components/${name}.ucf (imported by ${MAIN}): the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins (it compiles ${SVELTE_ID(`${name}.ucf`)})`
    );
  });

  it('fails with our message, naming the id, when plugin-svelte leaves our id out', async () => {
    const err = await build([svelte({exclude: [/\.ucf\.svelte\.svelte$/]}), multifront()]);
    expect(err.message).toContain(
      `${SVELTE_ID('Panel.ucf')}: @sveltejs/vite-plugin-svelte did not compile this module; its include and exclude options must let ids ending in .ucf.svelte.svelte through`
    );
  });
});
