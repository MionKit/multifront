import {createRequire} from 'node:module';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {getVueCompiler, multifront} from '@multifront/vite';
import {createLogger, createServer, type InlineConfig, type PluginOption} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp, buildCode} from './lib/build.ts';

let root: string;

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
  ])('plugin-vue listed %s multifront(): the .ucf files compile as Vue', async (_order, config) => {
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
    const config = inline([vue({exclude: [/VBind\.ucf$/]}), multifront()], ['index.html']);
    await expect(buildApp(root, config)).rejects.toThrow(/VBind\.ucf/);
  });

  it('keeps plugin-vue off our style ids when one file is imported as vue and as react', async () => {
    const {code} = await buildCode(root, inline([vue(), multifront()], ['index.html', 'src/bothTargets.ts']));
    expect(code).toContain('__name: "Counter"');
    expect(code).toContain('setCount');
  });

  it('fails a vue pick without plugin-vue, naming the import and its importer', async () => {
    const importer = join(root, 'src', 'bothTargets.ts');
    await expect(buildApp(root, inline([multifront()], ['src/bothTargets.ts']))).rejects.toThrow(
      `../../../components/Counter.ucf (imported by ${importer}): the vue target needs @vitejs/plugin-vue in your Vite plugins`
    );
  });
});

it('still compiles the .ucf file as Vue after a dev server restart with the same plugins', async () => {
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
    const counter = join(root, '..', '..', 'components', 'Counter.ucf');
    const result = await server.environments.client.transformRequest(`/@fs${counter}`);
    expect(errors).toEqual([]);
    expect(result?.code).toMatch(/__name: ["']Counter["']/);
    // The restart's `buildStart` must not wrap plugin-vue's compiler a second time.
    expect(getVueCompiler(server.config.plugins, root)).toBe(createRequire(import.meta.url)('vue/compiler-sfc'));
  } finally {
    await server.close();
  }
});
