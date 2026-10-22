// A `.vue` importer gets a `.front` file's Vue type with Vue's TypeScript plugin beside ours, in either load order,
// as VS Code loads them (each from its own folder) and from one install's `compilerOptions.plugins`.
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {edit, PLUGIN} from './lib/cases.ts';
import {E2E_DIR, inBlock, locate, open, startTsserver, VUE_PLUGIN, VUE_PLUGIN_DIR} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';
import {packVsix} from './lib/vsix.ts';

const PACK = 'multifront-typescript-plugin-pack';

// `tsconfig`: plugins from `compilerOptions.plugins`, else `--globalPlugins`.
const SETUPS = [
  {name: "VS Code: Vue's plugin, then our bundled pack", tsconfig: false, vueFirst: true},
  {name: "VS Code: our bundled pack, then Vue's plugin", tsconfig: false, vueFirst: false},
  {name: "tsconfig plugins: Vue's, then ours, one shared @volar/typescript", tsconfig: true, vueFirst: true},
  {name: "tsconfig plugins: ours, then Vue's, one shared @volar/typescript", tsconfig: true, vueFirst: false},
];

const read = (filename: string): Component => ({filename, source: readFileSync(filename, 'utf8')});

/** The folder tsserver loaded `name` from: its last try before that plugin validated. */
function loadedFrom(log: string, name: string): string | undefined {
  const start = log.indexOf(`Enabling plugin ${name} from candidate paths`);
  const end = log.indexOf('Plugin validation succeeded', start);
  if (start < 0 || end < 0) return undefined;
  return [...log.slice(start, end).matchAll(new RegExp(`Loading ${name} from (.+?) \\(resolved to`, 'g'))].at(-1)?.[1];
}

function volarCopy(fromPackage: string): string {
  return realpathSync(dirname(createRequire(fromPackage).resolve('@volar/typescript/package.json')));
}

let temp: string;
let extension: string;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-vue-importer-'));
  extension = await packVsix(temp);
}, 120_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

it('the tsconfig setups share one @volar/typescript copy between both plugins', () => {
  const ours = join(E2E_DIR, 'node_modules', '@multifront', 'language-tools', 'package.json');
  expect(volarCopy(realpathSync(ours))).toBe(volarCopy(join(VUE_PLUGIN_DIR, 'node_modules', VUE_PLUGIN, 'package.json')));
});

describe.each(SETUPS)('$name', ({tsconfig, vueFirst}) => {
  const ours = tsconfig ? PLUGIN : PACK;
  const plugins = vueFirst ? [VUE_PLUGIN, ours] : [ours, VUE_PLUGIN];
  let server: Tsserver;
  let logFile: string;
  let root: string;
  let app: Component;
  let counter: Component;

  beforeAll(async () => {
    // A copy: a case adds a file, and the tsconfig setups list the plugins.
    root = await copyApp('vue');
    if (tsconfig) {
      const config = readFileSync(join(root, 'tsconfig.json'), 'utf8');
      const listed = plugins.map((name) => `{"name": "${name}"}`).join(', ');
      writeFileSync(
        join(root, 'tsconfig.json'),
        config.replace('"compilerOptions": {', `"compilerOptions": {\n    "plugins": [${listed}],`)
      );
    }
    app = read(join(root, 'src', 'App.vue'));
    counter = read(join(root, '..', '..', 'components', 'Counter.front'));
    logFile = join(temp, `${tsconfig ? 'tsconfig' : 'global'}-${vueFirst ? 'vue' : 'ours'}-first.log`);
    server = startTsserver({
      cwd: root,
      plugins: tsconfig ? [] : plugins,
      // One install: both plugins from the project's node_modules.
      probeLocations: tsconfig ? [E2E_DIR] : [VUE_PLUGIN_DIR, extension],
      logFile,
    });
    await open(server, [app, counter]);
  });

  afterAll(async () => {
    await server?.stop();
    if (root) await removeApp(root);
  });

  const definitions = (needle: string, shift: number) =>
    server.request<TsDefinitions>('definition', {file: app.filename, ...locate(app.source, needle, shift)});

  // On a shared @volar/typescript copy, a diagnostic the inner plugin's proxy left as is must still map in the outer one.
  async function expectVueError(component: Component): Promise<void> {
    const [needle, newText] = ['{{ count }}', "{{ count.toFixed('x') }}"];
    const revert = await edit(server, component, needle, newText);
    try {
      const source = component.source.replace(needle, newText);
      const diagnostics = await server.diagnostics(component.filename);
      expect(diagnostics.filter(({code}) => code === 2345).map(({start, end}) => ({start, end}))).toEqual([
        {start: locate(source, "'x'"), end: locate(source, "'x'", 3)},
      ]);
    } finally {
      await revert();
    }
  }

  it(tsconfig ? "loads both plugins from the project's node_modules" : 'loads each plugin from its own folder', () => {
    const log = readFileSync(logFile, 'utf8');
    expect(loadedFrom(log, VUE_PLUGIN)).toBe(tsconfig ? E2E_DIR : VUE_PLUGIN_DIR);
    expect(loadedFrom(log, ours)).toBe(tsconfig ? E2E_DIR : extension);
  });

  it('App.vue as written has no error: every .front import resolves, its attribute included', async () => {
    expect(await server.diagnostics(app.filename)).toEqual([]);
  });

  it(`<Counter :start="'x'" /> is one TS2322, at start, mapped through both plugins' proxies`, async () => {
    const [needle, newText] = [':start="2"', `:start="'x'"`];
    const revert = await edit(server, app, needle, newText);
    try {
      const source = app.source.replace(needle, newText);
      const diagnostics = await server.diagnostics(app.filename);
      expect(diagnostics.map(({code, start, end}) => ({code, start, end}))).toEqual([
        {code: 2322, start: locate(source, ':start', 1), end: locate(source, ':start', ':start'.length)},
      ]);
    } finally {
      await revert();
    }
  });

  it('quick info on <Counter is the Vue component', async () => {
    const info = await server.request<TsQuickInfo>('quickinfo', {file: app.filename, ...locate(app.source, '<Counter', 1)});
    expect(info.displayString).toMatch(/^\(property\) Counter: DefineComponent</);
  });

  it('definition on <Counter is Counter.front at its start, as Volar gives a .vue component', async () => {
    const found = await definitions('<Counter', 1);
    expect(found.map(({file, start}) => ({file, start}))).toEqual([{file: counter.filename, start: {line: 1, offset: 1}}]);
  });

  it("definition on :start lands on its declaration in Counter.front's <vue> block", async () => {
    const found = await definitions(':start', 1);
    expect(found.map(({file, start}) => ({file, start}))).toEqual([
      {file: counter.filename, start: locate(counter.source, 'start?: number')},
    ]);
    expect(inBlock(counter, 'vue', found[0]!)).toBe(true);
  });

  it("Counter.front's own <vue> block still gets its errors, at the .front range", async () => {
    await expectVueError(counter);
  });

  it('a plain .vue import keeps working', async () => {
    const found = await definitions('<Plain', 1);
    expect(found.map(({file}) => file)).toEqual([join(root, 'src', 'Plain.vue')]);
  });

  // tsserver calls each plugin factory again on a reload: decorating the host twice loses the `.front` file's scripts.
  it('after a reload, a .front file added under src joins the project and is served as before', async () => {
    const added = {...counter, filename: join(root, 'src', 'Extra.front')};
    writeFileSync(added.filename, added.source);
    await server.request('reloadProjects');
    const info = await server.request<ts.server.protocol.ProjectInfo>('projectInfo', {
      file: app.filename,
      needFileNameList: true,
    });
    expect(info.fileNames).toContain(added.filename);
    expect(await server.diagnostics(app.filename)).toEqual([]);
    await open(server, [added]);
    await expectVueError(added);
    const found = await server.request<TsDefinitions>('definition', {
      file: added.filename,
      ...locate(added.source, '{{ count }}', 3),
    });
    expect(found.map(({file, start}) => ({file, start}))).toEqual([
      {file: added.filename, start: locate(added.source, 'count = ref')},
    ]);
  });
});
