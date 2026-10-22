// Svelte's own editor tools never load our TypeScript plugin: `.svelte` importers read the declarations
// `emitSvelteTypes` writes (found through `rootDirs`), and in tsserver our plugin runs beside Svelte's.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadSvelteCompiler, splitBlocks} from '@multifront/core';
import {emitSvelteTypes, getTypesScript} from '@multifront/language-tools';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {diagnosticsOf, edit, PLUGIN} from './lib/cases.ts';
import {startLanguageServer, TSDK} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {runSvelteCheck, saveFront, SVELTE_PLUGIN, SVELTE_SERVER} from './lib/svelte.ts';
import {E2E_DIR, locate, open, startTsserver} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';

const require = createRequire(import.meta.url);
const APP = 'svelte-vite';
const OUT = join('.front', 'svelte');

// `copyApp()` puts the app in `<copy>/apps/<name>`, beside `<copy>/components`.
const copyOf = (app: string): string => resolve(app, '..', '..');
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const read = (filename: string): Component => ({filename, source: readFileSync(filename, 'utf8')});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, {recursive: true, encoding: 'utf8'})
    .filter((name) => name.endsWith('.front.d.ts'))
    .sort();
}

/** `components/<path>.front.d.ts` for every copied `.front` file whose `<svelte>` block tsserver serves a script for. */
function expectedDeclarations(copy: string): string[] {
  const svelteCompiler = loadSvelteCompiler(copy);
  return readdirSync(join(copy, 'components'), {recursive: true, encoding: 'utf8'})
    .filter((name) => name.endsWith('.front'))
    .filter((name) => {
      const filename = join(copy, 'components', name);
      return !!getTypesScript(filename, readFileSync(filename, 'utf8'), 'svelte', {svelteCompiler});
    })
    .map((name) => join('components', `${name}.d.ts`))
    .sort();
}

describe('emitSvelteTypes writes a declaration per <svelte> block', () => {
  let app: string;
  let copy: string;
  let written: string[];

  beforeAll(async () => {
    app = await copyApp(APP);
    copy = copyOf(app);
    written = emitSvelteTypes({root: copy});
  });

  afterAll(async () => {
    if (app) await removeApp(app);
  });

  const declaration = (name: string) => readFileSync(join(copy, OUT, 'components', `${name}.d.ts`), 'utf8');

  it('one .front/svelte/components/<path>.front.d.ts per copied .front file with a <svelte> script, none for the others', () => {
    const expected = expectedDeclarations(copy);
    expect(expected.length).toBeGreaterThan(10);
    // Markup Svelte cannot parse gives no script, as in tsserver.
    expect(expected).not.toContain(join('components', 'svelte', 'errors', 'UnclosedBrace.front.d.ts'));
    expect(written.map((file) => relative(join(copy, OUT), file))).toEqual(expected);
    expect(filesUnder(join(copy, OUT))).toEqual(expected);
  });

  it("Panel.front.d.ts default-exports a Svelte Component with Panel's props", () => {
    const text = declaration('Panel.front');
    expect(text).toMatch(/import\("svelte"\)\.Component<\$\$ComponentProps/);
    expect(text).toMatch(/heading: string;/);
    expect(text).toMatch(/export default /);
  });

  it("a JavaScript block's declaration has its props typed", () => {
    expect(declaration('svelte/shapes/Slots.front')).toMatch(/depth\?: number \| undefined;/);
  });

  it('a block whose markup does not parse keeps its last declaration', () => {
    const panel = join(copy, 'components', 'Panel.front');
    const before = declaration('Panel.front');
    const source = readFileSync(panel, 'utf8');
    writeFileSync(panel, source.replace('</svelte>', '{</svelte>'));
    try {
      const again = emitSvelteTypes({root: copy});
      expect(again.map((file) => relative(join(copy, OUT), file))).not.toContain(join('components', 'Panel.front.d.ts'));
      expect(declaration('Panel.front')).toBe(before);
    } finally {
      writeFileSync(panel, source);
    }
  });

  it('removing the <svelte> block deletes the declaration on the next run', () => {
    const card = join(copy, 'components', 'Card.front');
    const source = readFileSync(card, 'utf8');
    const {start, end} = splitBlocks(source, card).targets.svelte!;
    writeFileSync(card, source.slice(0, start) + source.slice(end));
    emitSvelteTypes({root: copy});
    expect(filesUnder(join(copy, OUT))).not.toContain(join('components', 'Card.front.d.ts'));
    expect(filesUnder(join(copy, OUT))).toEqual(expectedDeclarations(copy));
  });
});

describe('emitSvelteTypes edge cases', () => {
  let app: string;
  let copy: string;

  beforeAll(async () => {
    app = await copyApp(APP);
    copy = copyOf(app);
  });

  afterAll(async () => {
    if (app) await removeApp(app);
  });

  it('a relative root and outDir are read from the current folder and the root', () => {
    const written = emitSvelteTypes({root: relative(process.cwd(), copy), outDir: 'out'});
    expect(written).toContain(join(copy, 'out', 'components', 'Panel.front.d.ts'));
    expect(filesUnder(join(copy, 'out'))).toEqual(expectedDeclarations(copy));
  });

  it("outDir as the root: declarations beside the sources, node_modules' own left alone", () => {
    const shipped = join(copy, 'node_modules', 'lib', 'Shipped.front.d.ts');
    mkdirSync(dirname(shipped), {recursive: true});
    writeFileSync(shipped, 'export {};\n');
    emitSvelteTypes({root: copy, outDir: copy});
    expect(existsSync(join(copy, 'components', 'Panel.front.d.ts'))).toBe(true);
    expect(existsSync(shipped)).toBe(true);
  });

  it('a block importing ./Plain.svelte, beside a Plain folder, still gets its declaration', () => {
    const uses = join(copy, 'components', 'UsesPlain.front');
    mkdirSync(join(copy, 'components', 'Plain'), {recursive: true});
    writeFileSync(
      uses,
      '<svelte lang="html">\n  <script lang="ts">\n    import Plain from \'./Plain.svelte\'\n  </script>\n  <Plain />\n</svelte>\n'
    );
    const written = emitSvelteTypes({root: copy});
    expect(written).toContain(join(copy, OUT, 'components', 'UsesPlain.front.d.ts'));
  });

  it('a project with no typescript: the error says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'multifront-no-typescript-'));
    try {
      mkdirSync(join(root, 'node_modules'));
      symlinkSync(dirname(require.resolve('svelte/package.json')), join(root, 'node_modules', 'svelte'), 'junction');
      const script = `import('@multifront/language-tools').then((tools) => tools.emitSvelteTypes({root: ${JSON.stringify(root)}}))`;
      // NODE_PATH would find the repo's typescript.
      const child = spawnSync(process.execPath, ['--conditions=source', '--input-type=module', '-e', script], {
        cwd: E2E_DIR,
        encoding: 'utf8',
        env: {...process.env, NODE_PATH: undefined},
      });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('Error: multifront: could not find typescript. Install typescript in your project.');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

describe('our language server writes them when a .front file is saved', () => {
  let app: string;
  let copy: string;
  let server: LanguageServer;

  beforeAll(async () => {
    app = await copyApp(APP);
    copy = copyOf(app);
    server = await startLanguageServer(copy, {initializationOptions: {typescript: {tsdk: TSDK}}});
  });

  afterAll(async () => {
    await server?.stop();
    if (app) await removeApp(app);
  });

  it('saving two files at once runs one emit', async () => {
    const files = ['Panel.front', 'Counter.front'].map((name) => join(copy, 'components', name));
    const documents = await Promise.all(files.map((file) => server.openTextDocument(file, 'front')));
    for (const {uri} of documents) await server.connection.sendNotification('textDocument/didSave', {textDocument: {uri}});
    const deadline = Date.now() + 30_000;
    while (!server.log.some(({message}) => message.includes('Svelte declarations')) && Date.now() < deadline) await pause(50);
    await pause(1000);
    const expected = `multifront: wrote ${expectedDeclarations(copy).length} Svelte declarations to ${join(copy, OUT)}`;
    expect(server.log.filter(({message}) => message.includes('Svelte declarations')).map(({message}) => message)).toEqual([
      expected,
    ]);
  });

  it('saving a file whose <svelte> block is gone deletes its declaration', async () => {
    const card = join(copy, 'components', 'Card.front');
    expect(filesUnder(join(copy, OUT))).toContain(join('components', 'Card.front.d.ts'));
    const source = readFileSync(card, 'utf8');
    const {start, end} = splitBlocks(source, card).targets.svelte!;
    writeFileSync(card, source.slice(0, start) + source.slice(end));
    expect(await saveFront(server, card)).toMatch(/^multifront: wrote /);
    expect(filesUnder(join(copy, OUT))).not.toContain(join('components', 'Card.front.d.ts'));
    expect(filesUnder(join(copy, OUT))).toEqual(expectedDeclarations(copy));
  });
});

describe('where and when our language server writes them', () => {
  let app: string;
  let copy: string;
  const servers: LanguageServer[] = [];

  beforeAll(async () => {
    app = await copyApp(APP);
    copy = copyOf(app);
  });

  afterAll(async () => {
    for (const server of servers) await server.stop();
    if (app) await removeApp(app);
  });

  const start = async (workspace: string | string[], tsdk = true) => {
    const server = await startLanguageServer(workspace, tsdk ? {initializationOptions: {typescript: {tsdk: TSDK}}} : {});
    servers.push(server);
    return server;
  };

  it('in a multi-root workspace, under the deepest folder holding the file', async () => {
    const components = join(copy, 'components');
    const server = await start([copy, components]);
    const message = await saveFront(server, join(components, 'Panel.front'));
    expect(message).toMatch(/^multifront: wrote \d+ Svelte declarations to /);
    expect(message.endsWith(` to ${join(components, OUT)}`)).toBe(true);
    expect(filesUnder(join(components, OUT))).toContain('Panel.front.d.ts');
    expect(existsSync(join(copy, OUT))).toBe(false);
    rmSync(join(components, '.front'), {recursive: true, force: true});
  });

  it('not without a tsdk', async () => {
    const server = await start(copy, false);
    const {uri} = await server.openTextDocument(join(copy, 'components', 'Panel.front'), 'front');
    await server.connection.sendNotification('textDocument/didSave', {textDocument: {uri}});
    await pause(1000);
    expect(server.log.filter(({message}) => message.includes('Svelte declarations'))).toEqual([]);
    expect(existsSync(join(copy, '.front'))).toBe(false);
  });

  it('a project with no Svelte: a warning, and the server keeps serving', async () => {
    const root = mkdtempSync(join(tmpdir(), 'multifront-no-svelte-'));
    try {
      const counter = join(root, 'Counter.front');
      writeFileSync(counter, readFileSync(join(copy, 'components', 'Counter.front'), 'utf8'));
      const server = await start(root);
      const warning = `multifront: no Svelte declarations for ${root} (multifront: could not find svelte. Install svelte in your project.)`;
      expect(await saveFront(server, counter)).toBe(warning);
      expect(server.log.find(({message}) => message === warning)?.type).toBe(2);
      expect(await saveFront(server, counter)).toBe(warning);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

describe('svelte-language-server reads the declarations our server writes on save', () => {
  let app: string;
  let copy: string;
  let svelteServer: LanguageServer;
  let ours: LanguageServer;
  let appSvelte: Component;

  beforeAll(async () => {
    app = await copyApp(APP);
    copy = copyOf(app);
    appSvelte = read(join(app, 'src', 'App.svelte'));
    svelteServer = await startLanguageServer(app, {server: SVELTE_SERVER, source: true});
    ours = await startLanguageServer(copy, {initializationOptions: {typescript: {tsdk: TSDK}}});
  });

  afterAll(async () => {
    await svelteServer?.stop();
    await ours?.stop();
    if (app) await removeApp(app);
  });

  it('before any emit: TS2307 at each .front import of App.svelte, and nothing else', async () => {
    const document = await svelteServer.openTextDocument(appSvelte.filename, 'svelte');
    const specifiers = [...appSvelte.source.matchAll(/'[^']*\.front'/g)].map(({index}) => document.positionAt(index));
    expect(specifiers).toHaveLength(4);
    const diagnostics = await diagnosticsOf(svelteServer, document);
    expect(diagnostics.map(({code, range}) => ({code, start: range.start}))).toEqual(
      specifiers.map((start) => ({code: 2307, start}))
    );
  });

  it('after a save in our server: no error, Panel is a Component, and a wrong prop is one error at it', async () => {
    const message = await saveFront(ours, join(copy, 'components', 'Panel.front'));
    const expected = expectedDeclarations(copy);
    expect(message).toBe(`multifront: wrote ${expected.length} Svelte declarations to ${join(copy, OUT)}`);
    expect(filesUnder(join(copy, OUT))).toEqual(expected);
    const changes = filesUnder(join(copy, OUT)).map((name) => ({uri: pathToFileURL(join(copy, OUT, name)).href, type: 1}));
    await svelteServer.connection.sendNotification('workspace/didChangeWatchedFiles', {changes});
    const document = await svelteServer.openTextDocument(appSvelte.filename, 'svelte');
    expect(await diagnosticsOf(svelteServer, document)).toEqual([]);

    const tag = appSvelte.source.indexOf('<Panel') + 1;
    const hover = await svelteServer.sendHoverRequest(document.uri, document.positionAt(tag));
    expect(JSON.stringify(hover?.contents)).toContain('Component<');

    const at = appSvelte.source.indexOf('heading="Imported panel"');
    const range = {start: document.positionAt(at), end: document.positionAt(at + 'heading="Imported panel"'.length)};
    const edited = await svelteServer.updateTextDocument(document.uri, [{range, newText: 'heading={1}'}]);
    const diagnostics = await diagnosticsOf(svelteServer, edited);
    expect(diagnostics.map(({code, range: {start}}) => ({code, start}))).toEqual([{code: 2322, start: edited.positionAt(at)}]);
  });
});

describe('svelte-check on the app', () => {
  let app: string;
  let copy: string;

  beforeAll(async () => {
    app = await copyApp(APP);
    copy = copyOf(app);
  });

  afterAll(async () => {
    if (app) await removeApp(app);
  });

  it('fails before the emit: TS2307 on the .front imports only', async () => {
    const {exitCode, problems} = await runSvelteCheck(app);
    expect(exitCode).toBe(1);
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem).toMatchObject({type: 'ERROR', code: 2307, message: expect.stringMatching(/\.front'/)});
    }
  });

  it('passes after emitSvelteTypes: no error, no warning', async () => {
    emitSvelteTypes({root: copy});
    expect(await runSvelteCheck(app)).toEqual({exitCode: 0, problems: []});
  });

  it('fails on App.svelte with a wrong prop: one error, at it', async () => {
    const page = read(join(app, 'src', 'App.svelte'));
    const wrong = page.source.replace('heading="Imported panel"', 'heading={1}');
    writeFileSync(page.filename, wrong);
    const at = locate(wrong, 'heading={1}');
    const {exitCode, problems} = await runSvelteCheck(app);
    expect(exitCode).toBe(1);
    expect(problems).toMatchObject([
      {
        type: 'ERROR',
        filename: 'src/App.svelte',
        start: {line: at.line - 1, character: at.offset - 1},
        message: expect.stringContaining('not assignable'),
      },
    ]);
  });
});

describe.each([
  {name: 'ours first', plugins: [PLUGIN, SVELTE_PLUGIN]},
  {name: "Svelte's first", plugins: [SVELTE_PLUGIN, PLUGIN]},
])('tsserver with typescript-svelte-plugin and our plugin, $name', ({plugins}) => {
  let app: string;
  let server: Tsserver;
  let mountAll: Component;
  let panel: Component;
  let appSvelte: Component;

  beforeAll(async () => {
    app = await copyApp(APP);
    // `rootDirs` also finds these: our plugin's pick must win over them.
    emitSvelteTypes({root: copyOf(app)});
    mountAll = read(join(app, 'src', 'mountAll.ts'));
    panel = read(join(copyOf(app), 'components', 'Panel.front'));
    appSvelte = read(join(app, 'src', 'App.svelte'));
    server = startTsserver({cwd: app, plugins, probeLocations: [E2E_DIR]});
    await open(server, [mountAll, panel]);
  });

  afterAll(async () => {
    await server?.stop();
    if (app) await removeApp(app);
  });

  const quickInfo = (needle: string, shift = 0) =>
    server.request<TsQuickInfo>('quickinfo', {file: mountAll.filename, ...locate(mountAll.source, needle, shift)});

  it('mountAll.ts as written has no error', async () => {
    expect(await server.diagnostics(mountAll.filename)).toEqual([]);
  });

  it("App is Svelte's plugin's component, not the ambient *.svelte type; Panel a Component", async () => {
    const appInfo = await quickInfo('mount(App', 'mount('.length);
    expect(appInfo.displayString).not.toContain('LegacyComponentType');
    expect(appInfo.displayString).toMatch(/App/);
    expect((await quickInfo('mount(Panel', 'mount('.length)).displayString).toMatch(/Component</);
  });

  it('a prop App does not take is one TS2322', async () => {
    const revert = await edit(server, mountAll, 'mount(App, {target});', 'mount(App, {target, props: {nope: 1}});');
    try {
      expect((await server.diagnostics(mountAll.filename)).map(({code}) => code)).toEqual([2322]);
    } finally {
      await revert();
    }
  });

  it('heading: 1 on Panel is one TS2322, at heading', async () => {
    const revert = await edit(server, mountAll, "heading: 'Svelte panel'", 'heading: 1');
    try {
      const source = mountAll.source.replace("heading: 'Svelte panel'", 'heading: 1');
      const diagnostics = await server.diagnostics(mountAll.filename);
      expect(diagnostics.map(({code, start}) => ({code, start}))).toEqual([{code: 2322, start: locate(source, 'heading: 1')}]);
    } finally {
      await revert();
    }
  });

  it('definition on App lands in App.svelte, on Panel in Panel.front', async () => {
    const definitions = (needle: string) =>
      server.request<TsDefinitions>('definition', {file: mountAll.filename, ...locate(mountAll.source, needle, 'mount('.length)});
    // svelte2tsx declares the component as a value and a type: two spots, both in App.svelte.
    expect(new Set((await definitions('mount(App')).map(({file}) => file))).toEqual(new Set([appSvelte.filename]));
    expect((await definitions('mount(Panel')).map(({file}) => file)).toEqual([panel.filename]);
  });
});
