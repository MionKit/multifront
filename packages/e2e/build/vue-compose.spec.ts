import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {multifront} from '@multifront/vite';
import {createLogger, createServer, type InlineConfig, type PluginOption} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {TMP_DIR, copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp} from './lib/build.ts';

const VUE_PLUGIN_MISSING = 'the vue target needs @vitejs/plugin-vue in your Vite plugins';

let root: string;
let counter: string;

beforeAll(async () => {
  root = await copyApp('vue');
  counter = join(root, '..', '..', 'components', 'Counter.ucf');
  return () => removeApp(root);
});

function inline(plugins: PluginOption[], input?: string[]): InlineConfig {
  // An app build drops an entry's exports unless told to keep them.
  const rolldownOptions = {input: input?.map((file) => join(root, file)), preserveEntrySignatures: 'strict' as const};
  const build = input ? {rolldownOptions} : {};
  return {configFile: false, plugins, build};
}

async function buildOutput(config: InlineConfig = {}) {
  const {chunks, css} = await buildApp(root, config);
  return {code: chunks.map((chunk) => chunk.code).join('\n'), css: css.join('\n')};
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('did not fail');
}

describe('vite build of the vue app', () => {
  it.each([
    ['before', () => ({})],
    ['after', () => inline([multifront(), vue()])],
  ])('plugin-vue listed %s multifront(): the .ucf files compile as Vue', async (_order, config) => {
    const {code, css} = await buildOutput(config());
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
    const {code} = await buildOutput(inline([vue({include: [/\.vue$/]}), multifront()], ['index.html']));
    expect(code).toContain('__name: "Plain"');
    expect(code).toContain('__name: "Counter"');
  });

  it('keeps plugin-vue off our style ids when one file is imported as vue and as react', async () => {
    const {code} = await buildOutput(inline([vue(), multifront()], ['index.html', 'src/bothTargets.ts']));
    expect(code).toContain('__name: "Counter"');
    expect(code).toContain('setCount');
  });

  it('fails a vue pick without plugin-vue, naming the import and its importer', async () => {
    const err = await rejection(buildApp(root, inline([multifront()], ['src/bothTargets.ts'])));
    const importer = join(root, 'src', 'bothTargets.ts');
    expect(err.message).toContain(`../../../components/Counter.ucf (imported by ${importer}): ${VUE_PLUGIN_MISSING}`);
  });
});

it('still compiles the .ucf file as Vue after a dev server restart with the same plugins', async () => {
  await mkdir(TMP_DIR, {recursive: true});
  const cacheDir = await mkdtemp(join(TMP_DIR, 'vue-compose-cache-'));
  const errors: string[] = [];
  const logger = createLogger('silent');
  logger.error = (message) => void errors.push(message);
  const server = await createServer({
    ...inline([vue(), multifront()]),
    root,
    cacheDir,
    customLogger: logger,
    server: {middlewareMode: true, ws: false},
    optimizeDeps: {noDiscovery: true},
  });
  try {
    await server.restart();
    const result = await server.environments.client.transformRequest(`/@fs${counter}`);
    expect(errors).toEqual([]);
    expect(result?.code).toMatch(/__name: ["']Counter["']/);
  } finally {
    try {
      await server.close();
    } finally {
      await rm(cacheDir, {recursive: true, force: true});
    }
  }
});
