// A `.ts` importer that picks vue for a `.ucf` import gets `Card.ucf.vue.ts`: the real Vue `DefineComponent`, with the
// global types it references. The plugin `pnpm devx vsix` bundles has its own checks in bundle.spec.ts.
import {dirname, join, resolve} from 'node:path';
import {getTypesScript} from '@multifront/language-tools';
import type {EditorOptions} from '@multifront/language-tools';
import typescript from 'typescript';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, readComponent} from '../fixtures/index.ts';
import {APP_DIR, CARD, edit, PLUGIN, readApp} from './lib/cases.ts';
import {locate, open, startTsserver} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';
import {LANGUAGE_CORE_TYPES} from './lib/vsix.ts';

const DEMO_DIR = join(FIXTURES_DIR, 'apps', 'demo');
const readDemo = (file: string): Component => readComponent(join('..', 'apps', 'demo', file));
const MOUNT_VUE = readDemo('src/mountVue.ts');
const DEMO_APP = readDemo('src/App.tsx');
const COUNTER = readComponent('Counter.ucf');
const BARE = readApp('vue-default/bare.ts');
const IMPORT_VUE = "import {createApp} from 'vue';";
const IMPORT_H = "import {createApp, h} from 'vue';";
const GLOBAL_TYPES = ['template-helpers.d.ts', 'props-fallback.d.ts'];
// The rows of the imports app where the importer's extension, or an attribute over it, picks vue.
const BY_IMPORTER = [
  {component: readApp('custom-importers/view.tsx'), name: 'Card'},
  {component: readApp('no-default/importer.mts'), name: 'Card'},
  {component: readApp('no-default/attribute-over-importer.tsx'), name: 'VueCard'},
];

const quickInfo = (server: Tsserver, {filename, source}: Component, needle: string, shift = 0) =>
  server.request<TsQuickInfo>('quickinfo', {file: filename, ...locate(source, needle, shift)});

/** A binding of the import is a `DefineComponent`: an unsaved `const picked = <name>;` at the end. */
async function expectDefineComponent(server: Tsserver, component: Component, name: string): Promise<void> {
  const last = component.source.trimEnd().split('\n').at(-1)!;
  const added = `${last}\nconst picked = ${name};`;
  const revert = await edit(server, component, last, added);
  try {
    const edited = {...component, source: component.source.replace(last, added)};
    expect((await quickInfo(server, edited, 'const picked', 6)).displayString).toMatch(/^const picked: DefineComponent</);
  } finally {
    await revert();
  }
}

async function fileNames(server: Tsserver, file: string): Promise<string[]> {
  const info = await server.request<ts.server.protocol.ProjectInfo>('projectInfo', {file, needFileNameList: true});
  return info.fileNames ?? [];
}

describe('tsserver with our plugin: a .ts file picking vue gets Card.ucf.vue.ts', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: DEMO_DIR, plugins: [PLUGIN]});
    await open(server, [MOUNT_VUE, DEMO_APP, COUNTER, BARE, ...BY_IMPORTER.map(({component}) => component)]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  /** mountVue.ts with `h` imported and `uses` after the import, as an unsaved edit undone after `check`. */
  async function withUses(uses: string, check: (edited: Component) => Promise<void>): Promise<void> {
    const added = `${IMPORT_H}\n${uses}`;
    const revert = await edit(server, MOUNT_VUE, IMPORT_VUE, added);
    try {
      await check({...MOUNT_VUE, source: MOUNT_VUE.source.replace(IMPORT_VUE, added)});
    } finally {
      await revert();
    }
  }

  it('mountVue.ts as written has no error', async () => {
    expect(await server.diagnostics(MOUNT_VUE.filename)).toEqual([]);
  });

  it('Counter is a Vue DefineComponent whose start prop is a number', async () => {
    // Language-core exports an expression, `{} as typeof …`: quick info on the import names no type.
    expect((await quickInfo(server, MOUNT_VUE, 'import Counter', 7)).displayString).toBe('import Counter');
    await withUses('const counter = Counter;\nh(Counter, {start: 1});', async (edited) => {
      expect((await quickInfo(server, edited, 'const counter', 6)).displayString).toMatch(/^const counter: DefineComponent</);
      expect((await quickInfo(server, edited, 'start: 1')).displayString).toBe('(property) start?: number | undefined');
      expect(await server.diagnostics(MOUNT_VUE.filename)).toEqual([]);
    });
  });

  it("h(Counter, {start: 'x'}) is one error, at the start prop", async () => {
    await withUses("h(Counter, {start: 'x'});", async ({source}) => {
      const diagnostics = await server.diagnostics(MOUNT_VUE.filename);
      expect(diagnostics.map(({code, start, end}) => ({code, start, end}))).toEqual([
        {code: 2769, start: locate(source, "start: 'x'"), end: locate(source, "start: 'x'", 'start'.length)},
      ]);
    });
  });

  it('App.tsx keeps the React type of the same file', async () => {
    const {displayString} = await quickInfo(server, DEMO_APP, '<Counter', 1);
    expect(displayString).not.toContain('DefineComponent');
    expect(displayString).toContain('start?: number');
  });

  it('definition on Counter lands in Counter.ucf, generated code mapped to the file itself', async () => {
    const definitions = await server.request<TsDefinitions>('definition', {
      file: MOUNT_VUE.filename,
      ...locate(MOUNT_VUE.source, 'createApp(Counter)', 'createApp('.length),
    });
    expect(definitions.map(({file, start}) => ({file, start}))).toEqual([{file: COUNTER.filename, start: {line: 1, offset: 1}}]);
  });

  it('definition on the start prop lands on its declaration in Counter.ucf', async () => {
    await withUses('h(Counter, {start: 1});', async ({source}) => {
      const definitions = await server.request<TsDefinitions>('definition', {
        file: MOUNT_VUE.filename,
        ...locate(source, 'start: 1'),
      });
      expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
        {file: COUNTER.filename, start: locate(COUNTER.source, 'start?: number')},
      ]);
    });
  });

  it('rename of the start prop edits mountVue.ts and Counter.ucf, no generated code', async () => {
    await withUses('h(Counter, {start: 1});', async ({source}) => {
      const {locs} = await server.request<ts.server.protocol.RenameResponseBody>('rename', {
        file: MOUNT_VUE.filename,
        ...locate(source, 'start: 1'),
      });
      expect(locs.map(({file, locs: spans}) => ({file, starts: spans.map(({start}) => start)}))).toEqual([
        {file: MOUNT_VUE.filename, starts: [locate(source, 'start: 1')]},
        {
          file: COUNTER.filename,
          starts: [locate(COUNTER.source, 'props.start', 'props.'.length), locate(COUNTER.source, 'start?: number')],
        },
      ]);
    });
  });

  it("the plugin option framework: 'vue' gives a bare import the Vue type", async () => {
    await expectDefineComponent(server, BARE, 'Card');
  });

  it.each(BY_IMPORTER)('$component.filename: the Vue type', async ({component, name}) => {
    await expectDefineComponent(server, component, name);
  });

  it("projectInfo lists language-core's global types from its installed types/ folder", async () => {
    const names = await fileNames(server, MOUNT_VUE.filename);
    for (const name of GLOBAL_TYPES) expect(names).toContain(join(LANGUAGE_CORE_TYPES, name));
  });
});

describe('an edit of Card.ucf reaches a project that picks only vue from it', () => {
  let server: Tsserver;
  const usage = {...BARE, source: `${BARE.source}import {h} from 'vue';\nh(Card, {title: 1});\n`};

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    // Opened with the use already in it: no edit of bare.ts marks its project dirty again.
    await open(server, [usage, CARD]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("h(Card, {title: 1}) is an error, and none once Card.ucf's prop is a number", async () => {
    expect((await server.diagnostics(usage.filename)).map(({code}) => code)).toEqual([2769]);
    const revert = await edit(server, CARD, '{ title: string }', '{ title: number }');
    try {
      expect(await server.diagnostics(usage.filename)).toEqual([]);
    } finally {
      await revert();
    }
  });
});

describe('getTypesScript, as each plugin copy runs it', () => {
  const typesRoot = (options: EditorOptions): string => {
    const code = getTypesScript(COUNTER.filename, COUNTER.source, 'vue', {ts: typescript, ...options})!.code;
    const [, path] = /<reference types="(.+)\/template-helpers\.d\.ts"/.exec(code)!;
    return resolve(dirname(COUNTER.filename), path!);
  };

  it('references the global types in vueTypesRoot, and in the installed language-core without it', () => {
    const copy = join(FIXTURES_DIR, '..', 'vue-types');
    expect(typesRoot({vueTypesRoot: copy})).toBe(copy);
    expect(typesRoot({})).toBe(LANGUAGE_CORE_TYPES);
  });
});
