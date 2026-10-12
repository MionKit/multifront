import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {TraceMap, eachMapping} from '@jridgewell/trace-mapping';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {BuildContext} from '@multifront/core';
import {multifront} from '@multifront/vite';
import type {InlineConfig, Rolldown} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {buildApp, rejection, withDevServer} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'svelte-vite');
const MAIN = join(ROOT, 'src', 'main.ts');
const COMPONENTS = ['Panel.ucf', 'PanelItem.ucf', 'Counter.ucf'];
const SVELTE_MARKERS = ['panel-svelte-marker', 'panel-item-svelte-marker'];
// Panel's own <vue> and <react> blocks carry no marker.
const OTHER_MARKERS = ['panel-item-vue-marker', 'panel-item-react-marker'];
const SVELTE_ID = (name: string) => `${componentPath(name)}.svelte.svelte`;

async function contextOf(name: string, production = true): Promise<BuildContext> {
  const {filename, source} = readComponent(name);
  return createBuildContext(splitBlocks(source, filename), {root: ROOT, compiler: loadVueCompiler(ROOT), production});
}

/** The lines of Panel.ucf that `map` points at, checked to lie in its <svelte> block, one of them `{heading}`'s. */
function expectPanelMappings(map: ConstructorParameters<typeof TraceMap>[0]): void {
  const {source} = readComponent('Panel.ucf');
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const lines: number[] = [];
  eachMapping(new TraceMap(map), (mapping) => {
    // Dev maps name the source relative to the module, beside it; build maps relative to the output.
    if (/(?:^|\/)Panel\.ucf$/.test(mapping.source ?? '')) lines.push(mapping.originalLine!);
  });
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toBeGreaterThanOrEqual(lineOf(source.indexOf('<svelte>')));
  for (const line of lines) expect(line).toBeLessThanOrEqual(lineOf(source.indexOf('</svelte>')));
  // The React block holds `{heading}` too; the Svelte block comes last.
  expect(lines).toContain(lineOf(source.lastIndexOf('{heading}')));
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

describe('dev server of svelte-vite', () => {
  it('serves the compiled Panel module at the URL main.ts imports, mapped into Panel.ucf and watching it', async () => {
    // plugin-svelte pre-bundles svelte: its cache must stay out of the fixture app.
    await mkdir(TMP_DIR, {recursive: true});
    const cacheDir = await mkdtemp(join(TMP_DIR, 'svelte-vite-cache-'));
    await withDevServer(ROOT, {cacheDir}, async (server) => {
      const client = server.environments.client;
      const main = await client.transformRequest('/src/main.ts');
      const url = /from "([^"]+Panel\.ucf\.svelte\.svelte)"/.exec(main!.code)?.[1];
      expect(url).toBeDefined();
      const result = await client.transformRequest(url!);
      expect(result?.code).toMatch(/from "[^"]*svelte[/_]internal[/_]client/);
      expectPanelMappings(result!.map as ConstructorParameters<typeof TraceMap>[0]);
      const module = await client.moduleGraph.getModuleByUrl(url!);
      expect(module?.id).toBe(SVELTE_ID('Panel.ucf'));
      expect([...module!.importedModules].map(({id}) => id)).toContain(componentPath('Panel.ucf'));
    }).finally(() => rm(cacheDir, {recursive: true, force: true}));
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
