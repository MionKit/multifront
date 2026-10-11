import {mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type DevEnvironment, type Plugin, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {TMP_DIR, copyApp, removeApp} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER} from './lib/build.ts';

const ENVIRONMENTS = ['client', 'ssr'] as const;
type EnvironmentName = (typeof ENVIRONMENTS)[number];

interface Update {
  environment: string;
  type: string;
  file: string;
  source: string | undefined; // an update's new text
  given: string[]; // what our hook returned: this plugin sorts right after it
  byFile: string[]; // what Vite gave our hook
}

const SCOPED_STYLE = '<style scoped>\n.counter {\n  color: rgb(120, 40, 160);\n}\n</style>\n';
const UNCLOSED_MODULE = ['padding: 4px 12px;\n}\n</style>', 'padding: 4px 12px;\n}\n'] as const;

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
  // The module style moves to index 0; index 1 is gone, so neither css1 nor map1 comes back.
  ['a removed <style>', SCOPED_STYLE, '', ['css0', 'react']],
  ['the module name', '<style module>', '<style module="classes">', ['css1', 'react']],
  ['a new <svelte> block (its module never loaded)', '</react>\n', '</react>\n\n<svelte>\n<p>hi</p>\n</svelte>\n', []],
  ['a splitter error (unclosed module style)', ...UNCLOSED_MODULE, ['css0', 'react']],
];

function recorder(records: Update[]): Plugin {
  return {
    name: 'hmr-recorder',
    // After ours, as the config file's plugins come first: it gets exactly what our hook returned.
    enforce: 'pre',
    async hotUpdate({type, file, modules, read}) {
      const environment: DevEnvironment = this.environment;
      const byFile = [...(environment.moduleGraph.getModulesByFile(file) ?? [])].flatMap((mod) => mod.id ?? []);
      const source = type === 'update' ? await read() : undefined;
      records.push({environment: environment.name, type, file, source, given: modules.flatMap((mod) => mod.id ?? []), byFile});
    },
  };
}

function hmrApp(plugins: () => Plugin[]) {
  const records: Update[] = [];
  const state: {root?: string; file: string; app: string; original: string; server?: ViteDevServer; cacheDir?: string} = {
    file: '',
    app: '',
    original: '',
  };

  const names = (ids: string[]) =>
    ids.map((id) => {
      if (id === `${state.file}.react.tsx`) return 'react';
      if (id === state.file) return 'bare';
      if (id === `${state.file}?raw`) return 'raw';
      const match = /^.*\?ucf&type=style&index=(\d+)(&module)?&lang\.(css|js)$/.exec(id);
      return match ? `${match[2] ? 'map' : 'css'}${match[1]}` : id;
    });

  async function updated(matches: (update: Update) => boolean): Promise<Record<EnvironmentName, Update>> {
    let found: Partial<Record<EnvironmentName, Update>> = {};
    await expect
      .poll(
        () => {
          found = Object.fromEntries(
            ENVIRONMENTS.map((name) => [name, records.findLast((update) => update.environment === name && matches(update))])
          );
          return ENVIRONMENTS.every((name) => found[name]);
        },
        {timeout: 10_000, interval: 50}
      )
      .toBe(true);
    return found as Record<EnvironmentName, Update>;
  }

  // From App.tsx, as a page does: Vite links the React module to Counter.ucf only if the module existed before load.
  async function crawl(): Promise<void> {
    for (const name of ENVIRONMENTS) {
      const environment = state.server!.environments[name];
      // `?raw` stands for another plugin's module of the file.
      const pending = ['/src/App.tsx', `/@fs${state.file}?raw`];
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

  async function write(file: string, source: string): Promise<Record<EnvironmentName, Update>> {
    records.length = 0;
    await writeFile(file, source);
    return updated((update) => update.file === file && update.source === source);
  }

  beforeAll(async () => {
    state.root = await copyApp('demo');
    state.file = resolve(state.root, '..', '..', 'components', 'Counter.ucf');
    state.app = join(state.root, 'src', 'App.tsx');
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

  afterAll(async () => {
    await state.server?.close();
    if (state.cacheDir) await rm(state.cacheDir, {recursive: true, force: true});
    if (state.root) await removeApp(state.root);
  });

  return {
    state,
    names,
    crawl,
    write,
    updated,
    records,
    async restore() {
      if ((await readFile(state.file, 'utf8')) !== state.original) await write(state.file, state.original);
      await crawl();
      records.length = 0;
    },
    edit(from: string, to: string) {
      expect(state.original).toContain(from);
      return write(state.file, state.original.replace(from, to));
    },
  };
}

function returned(app: ReturnType<typeof hmrApp>, updates: Record<EnvironmentName, Update>) {
  return Object.fromEntries(ENVIRONMENTS.map((name) => [name, app.names(updates[name].given).sort()]));
}

function inBoth(names: string[]) {
  const sorted = [...names].sort();
  return {client: sorted, ssr: sorted};
}

describe('hotUpdate of a .ucf file (demo, Counter.ucf), in client and SSR', () => {
  const app = hmrApp(() => []);

  beforeEach(() => app.restore());

  // `raw` is another plugin's module of the file: always handed on.
  it.each(EDITS)('%s', async (_what, from, to, expected) => {
    const updates = await app.edit(from, to);
    for (const name of ENVIRONMENTS) {
      // The bare node is the React module's watch edge; without plugin-vue nothing decides a Vue update.
      expect({name, byFile: app.names(updates[name].byFile)}).toEqual({name, byFile: expect.arrayContaining(['bare'])});
    }
    expect(returned(app, updates)).toEqual(inBoth([...expected, 'raw']));
  });

  it('fixing a splitter error updates every style, class map and target module of the new split', async () => {
    await app.edit(...UNCLOSED_MODULE);
    const updates = await app.write(app.state.file, app.state.original);
    expect(returned(app, updates)).toEqual(inBoth(['css0', 'css1', 'map1', 'react', 'raw']));
  });

  it('counts the class map as changed when the old version was never compiled', async () => {
    // Nothing loads the version this edit makes: no module of ours is updated.
    await app.edit('<span class="label">Clicks</span>', '<span class="label">Hits</span>');
    const updates = await app.write(
      app.state.file,
      app.state.original.replace('<span class="label">Clicks</span>', '<span class="label">Hits</span>').replace('4px', '5px')
    );
    expect(returned(app, updates)).toEqual(inBoth(['css1', 'map1', 'raw']));
  });
});

describe('hotUpdate with plugin-vue in the app', () => {
  const app = hmrApp(() => [vue()]);

  beforeEach(() => app.restore());

  it.each([
    ['<vue> text', '<span class="label">Clicks</span>', '<span class="label">Hits</span>', ['bare']],
    ['a scoped declaration', 'rgb(120, 40, 160)', 'rgb(10, 20, 30)', ['bare', 'css0']],
  ])('%s hands the bare module on to plugin-vue', async (_what, from, to, expected) => {
    expect(returned(app, await app.edit(from, to))).toEqual(inBoth([...expected, 'raw']));
  });
});

// In order: the first save comes before any edit.
describe('hotUpdate beyond edits of a served file', () => {
  const app = hmrApp(() => []);

  it('a save that changes nothing updates none of our modules', async () => {
    const updates = await app.write(app.state.file, app.state.original);
    expect(returned(app, updates)).toEqual(inBoth(['raw']));
  });

  it('leaves a file that is no .ucf as Vite listed it', async () => {
    const source = await readFile(app.state.app, 'utf8');
    const updates = await app.write(app.state.app, `${source}\n// edited\n`);
    for (const name of ENVIRONMENTS) expect({name, given: updates[name].given}).toEqual({name, given: updates[name].byFile});
  });

  it('leaves a deleted .ucf file to Vite', async () => {
    app.records.length = 0;
    await unlink(app.state.file);
    const updates = await app.updated((update) => update.file === app.state.file && update.type === 'delete');
    for (const name of ENVIRONMENTS) expect({name, given: updates[name].given}).toEqual({name, given: updates[name].byFile});
  });
});
