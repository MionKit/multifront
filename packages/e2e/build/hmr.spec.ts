import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type DevEnvironment, type Plugin, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {TMP_DIR, copyApp, removeApp} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER} from './lib/build.ts';

const ENVIRONMENTS = ['client', 'ssr'] as const;
type EnvironmentName = (typeof ENVIRONMENTS)[number];

interface Update {
  source: string;
  given: string[]; // what our hook returned: this plugin sorts right after it
  byFile: string[]; // what Vite gave our hook
}

// One edit per row: [what, from, to, our modules returned]; css<N>, map<N> and react name ids of Counter.ucf.
const EDITS: [string, string, string, string[]][] = [
  ['a scoped declaration', 'rgb(120, 40, 160)', 'rgb(10, 20, 30)', ['css0']],
  ['a module declaration (dev class names ignore the CSS)', 'padding: 4px 12px', 'padding: 5px 12px', ['css1']],
  ['a new module class', 'padding: 4px 12px;\n}', 'padding: 4px 12px;\n}\n.extra {\n  color: red;\n}', ['css1', 'map1']],
  ['<react> text', '<span className="label">Clicks</span>', '<span className="label">Taps</span>', ['react']],
  ['<vue> text', '<span class="label">Clicks</span>', '<span class="label">Hits</span>', []],
  ['whitespace between blocks', '</vue>\n', '</vue>\n\n\n', []],
  ['the scoped flag', '<style scoped>', '<style>', ['css0', 'react']],
  [
    'a third <style>',
    'padding: 4px 12px;\n}\n</style>',
    'padding: 4px 12px;\n}\n</style>\n\n<style>\n.more {\n  color: red;\n}\n</style>',
    ['react'],
  ],
  ['the module name', '<style module>', '<style module="classes">', ['css1', 'react']],
  ['a new <svelte> block (its module never loaded)', '</react>\n', '</react>\n\n<svelte>\n<p>hi</p>\n</svelte>\n', []],
  ['a splitter error', 'padding: 4px 12px;\n}\n</style>', 'padding: 4px 12px;\n}\n', ['css0', 'css1', 'map1', 'react']],
];

function recorder(records: Map<string, Update[]>): Plugin {
  return {
    name: 'hmr-recorder',
    // After ours, as the config file's plugins come first: it gets exactly what our hook returned.
    enforce: 'pre',
    async hotUpdate({file, modules, read}) {
      const environment: DevEnvironment = this.environment;
      const byFile = [...(environment.moduleGraph.getModulesByFile(file) ?? [])].flatMap((mod) => mod.id ?? []);
      const list = records.get(environment.name) ?? [];
      list.push({source: await read(), given: modules.flatMap((mod) => mod.id ?? []), byFile});
      records.set(environment.name, list);
    },
  };
}

function hmrApp(plugins: () => Plugin[]) {
  const records = new Map<string, Update[]>();
  const state: {root?: string; file: string; original: string; server?: ViteDevServer; cacheDir?: string} = {
    file: '',
    original: '',
  };

  const names = (ids: string[]) =>
    ids.map((id) => {
      if (id === `${state.file}.react.tsx`) return 'react';
      if (id === state.file) return 'bare';
      const match = /^.*\?ucf&type=style&index=(\d+)(&module)?&lang\.(css|js)$/.exec(id);
      return match ? `${match[2] ? 'map' : 'css'}${match[1]}` : id;
    });

  // Both environments saw the hot update of `source`.
  async function updated(source: string): Promise<Record<EnvironmentName, Update>> {
    let found: Partial<Record<EnvironmentName, Update>> = {};
    await expect
      .poll(
        () => {
          found = Object.fromEntries(
            ENVIRONMENTS.map((name) => [name, records.get(name)?.findLast((update) => update.source === source)])
          );
          return ENVIRONMENTS.every((name) => found[name]);
        },
        {timeout: 10_000, interval: 50}
      )
      .toBe(true);
    return found as Record<EnvironmentName, Update>;
  }

  // From the importer, as a page or an SSR render requests them: Vite ties the React module's watch file to it
  // only when the module was already in the graph when it loaded.
  async function crawl(): Promise<void> {
    for (const name of ENVIRONMENTS) {
      const environment = state.server!.environments[name];
      const pending = ['/src/App.tsx'];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const url = pending.pop()!;
        if (seen.has(url)) continue;
        seen.add(url);
        await environment.transformRequest(url);
        const mod = await environment.moduleGraph.getModuleByUrl(url);
        for (const imported of mod?.importedModules ?? []) {
          const id = imported.id ?? '';
          if (id === `${state.file}.react.tsx` || id.startsWith(`${state.file}?ucf&`)) pending.push(imported.url);
        }
      }
    }
  }

  async function write(source: string): Promise<Record<EnvironmentName, Update>> {
    records.clear();
    await writeFile(state.file, source);
    return updated(source);
  }

  beforeAll(async () => {
    state.root = await copyApp('demo');
    state.file = resolve(state.root, '..', '..', 'components', 'Counter.ucf');
    state.original = await readFile(state.file, 'utf8');
    state.cacheDir = await mkdtemp(join(TMP_DIR, 'hmr-cache-'));
    state.server = await createServer({
      root: state.root,
      configLoader: APP_CONFIG_LOADER,
      cacheDir: state.cacheDir,
      logLevel: 'silent',
      plugins: [...plugins(), recorder(records)],
      server: {middlewareMode: true, ws: false, preTransformRequests: false},
      optimizeDeps: {noDiscovery: true},
    });
    await crawl();
  });

  beforeEach(async () => {
    if ((await readFile(state.file, 'utf8')) !== state.original) await write(state.original);
    await crawl();
    records.clear();
  });

  afterAll(async () => {
    await state.server?.close();
    if (state.cacheDir) await rm(state.cacheDir, {recursive: true, force: true});
    if (state.root) await removeApp(state.root);
  });

  return {
    async edit(from: string, to: string) {
      expect(state.original).toContain(from);
      return write(state.original.replace(from, to));
    },
    names,
  };
}

describe('hotUpdate of a .ucf file (demo, Counter.ucf), in client and SSR', () => {
  const app = hmrApp(() => []);

  it.each(EDITS)('%s', async (_what, from, to, expected) => {
    const updates = await app.edit(from, to);
    for (const name of ENVIRONMENTS) {
      const {given, byFile} = updates[name];
      // The bare node is the React module's watch edge; without plugin-vue nothing decides a Vue update.
      expect({name, byFile: app.names(byFile)}).toEqual({name, byFile: expect.arrayContaining(['bare'])});
      expect({name, ours: app.names(given).sort()}).toEqual({name, ours: [...expected].sort()});
    }
  });
});

describe('hotUpdate with plugin-vue in the app', () => {
  const app = hmrApp(() => [vue()]);

  it.each([
    ['<vue> text', '<span class="label">Clicks</span>', '<span class="label">Hits</span>', ['bare']],
    ['a scoped declaration', 'rgb(120, 40, 160)', 'rgb(10, 20, 30)', ['bare', 'css0']],
  ])('%s hands the bare module on to plugin-vue', async (_what, from, to, expected) => {
    const updates = await app.edit(from, to);
    for (const name of ENVIRONMENTS) {
      expect({name, given: app.names(updates[name].given).sort()}).toEqual({name, given: [...expected].sort()});
    }
  });
});
