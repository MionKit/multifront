import {mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {rewriteImportAttributes} from '@multifront/core';
import {emitSvelteTypes} from '@multifront/language-tools';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, FIXTURES_DIR, readComponent, removeApp} from '../fixtures/index.ts';
import {
  APP,
  APP_DIR,
  appTsxCases,
  CARD,
  codesOnLine,
  edit,
  expectSvelteComponent,
  languageServerCases,
  MIXED,
  MIXED_LINES,
  onLine,
  PLUGIN,
  readApp,
} from './lib/cases.ts';
import {startLanguageServer, TSDK} from './lib/lsp.ts';
import {addFile, bothHosts, breakSvelteMarkup, BROKEN} from './lib/tsc.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {saveUcf} from './lib/svelte.ts';
import {E2E_DIR, locate, open, startTsserver} from './lib/tsserver.ts';
import type {TsQuickInfo, Tsserver} from './lib/tsserver.ts';
import {packVsix, REPO_ROOT} from './lib/vsix.ts';

const PACK = 'multifront-typescript-plugin-pack';
const NON_LITERAL = readApp('no-default/non-literal.ts');
const VUE_PICK = readApp('no-default/attribute-over-importer.tsx');
const SVELTE_PICK = readApp('src/lazy.ts');
const GLOBAL_TYPES = ['template-helpers.d.ts', 'props-fallback.d.ts'];
const SVELTE_SHIMS = 'svelte-shims-v4.d.ts';
const STEPS_ASIDE = 'multifront: another copy of the TypeScript plugin already serves this project; this one steps aside';

// Every check runs on what the .vsix ships, not on packages/vscode/dist.
let temp: string;
let extension: string;

beforeAll(async () => {
  // tsserver lists real paths, and macOS's temp folder is a link (/var to /private/var).
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'multifront-bundle-')));
  extension = await packVsix(temp);
}, 120_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

describe('the bundled language server, dist/server.cjs, with no source condition', () => {
  let server: LanguageServer;

  beforeAll(async () => {
    server = await startLanguageServer(join(FIXTURES_DIR, 'components'), {
      server: join(extension, 'dist', 'server.cjs'),
      initializationOptions: {typescript: {tsdk: TSDK}},
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  languageServerCases(() => server);
});

describe('the bundled server writes Svelte declarations on save', () => {
  let app: string;
  let server: LanguageServer;

  beforeAll(async () => {
    app = await copyApp('svelte-vite');
    server = await startLanguageServer(resolve(app, '..', '..'), {
      server: join(extension, 'dist', 'server.cjs'),
      initializationOptions: {typescript: {tsdk: TSDK}},
    });
  });

  afterAll(async () => {
    await server?.stop();
    if (app) await removeApp(app);
  });

  it("the same files as emitSvelteTypes from source: svelte2tsx ran on the tsdk's TypeScript", async () => {
    const copy = resolve(app, '..', '..');
    const outDir = join(copy, '.ucf', 'svelte');
    expect(await saveUcf(server, join(copy, 'components', 'Panel.ucf'))).toMatch(/^multifront: wrote \d+ Svelte declarations/);
    const direct = join(temp, 'svelte-direct');
    const expected = emitSvelteTypes({root: copy, outDir: direct}).map((file) => relative(direct, file));
    expect(expected.length).toBeGreaterThan(10);
    const bundled = readdirSync(outDir, {recursive: true, encoding: 'utf8'}).filter((name) => name.endsWith('.d.ts'));
    expect(bundled.sort()).toEqual(expected);
    for (const name of expected) expect(readFileSync(join(outDir, name), 'utf8')).toBe(readFileSync(join(direct, name), 'utf8'));
  });
});

describe('tsserver with the plugin pack alone, as VS Code with its own TypeScript loads it', () => {
  let server: Tsserver;
  let logFile: string;

  beforeAll(async () => {
    logFile = join(temp, 'pack-alone.log');
    // Isolated hides the project's own entry: the pack is the only plugin.
    server = startTsserver({cwd: APP_DIR, plugins: [PACK], probeLocations: [extension], isolated: true, logFile});
    await open(server, [APP, CARD, NON_LITERAL, VUE_PICK, SVELTE_PICK]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("the project's own plugin entry is not found; the pack loads", () => {
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain(`Failed to load module '${PLUGIN}'`);
    const loading = log.indexOf(`Loading global plugin ${PACK}`);
    expect(loading).toBeGreaterThan(-1);
    expect(log.indexOf('Plugin validation succeeded', loading)).toBeGreaterThan(loading);
    expect(log).not.toContain(`Failed to load module '${PACK}'`);
  });

  appTsxCases(() => server);

  it('a vue pick gets a DefineComponent, with the global types copied beside the bundle', async () => {
    const last = 'export {VueCard};';
    const added = `${last}\nconst picked = VueCard;`;
    const revert = await edit(server, VUE_PICK, last, added);
    try {
      const info = await server.request<TsQuickInfo>('quickinfo', {
        file: VUE_PICK.filename,
        ...locate(VUE_PICK.source.replace(last, added), 'const picked', 6),
      });
      expect(info.displayString).toMatch(/^const picked: DefineComponent</);
    } finally {
      await revert();
    }
    const {fileNames = []} = await server.request<ts.server.protocol.ProjectInfo>('projectInfo', {
      file: VUE_PICK.filename,
      needFileNameList: true,
    });
    for (const name of GLOBAL_TYPES) expect(fileNames).toContain(join(extension, 'dist', 'vue-types', name));
    expect(fileNames.filter((name) => name.includes('@vue/language-core'))).toEqual([]);
  });

  it("a svelte pick gets a Component, with the shims copied beside the bundle and the project's svelte", async () => {
    await expectSvelteComponent(server, SVELTE_PICK, 'SvelteCard.default');
    const {fileNames = []} = await server.request<ts.server.protocol.ProjectInfo>('projectInfo', {
      file: SVELTE_PICK.filename,
      needFileNameList: true,
    });
    expect(fileNames).toContain(join(extension, 'dist', 'svelte-types', SVELTE_SHIMS));
    // Shims' `import('svelte')` and element types' `svelte/elements` read the project's Svelte: none sits beside the bundle.
    const svelte = realpathSync(join(REPO_ROOT, 'node_modules', 'svelte'));
    const svelteTypes = fileNames.filter((name) => /\/svelte\/(types\/index|svelte-html|elements)\.d\.ts$/.test(name));
    // One file can appear by link and by real path.
    expect([...new Set(svelteTypes.map((name) => realpathSync(name)))].sort()).toEqual(
      ['elements.d.ts', 'svelte-html.d.ts', join('types', 'index.d.ts')].map((name) => join(svelte, name))
    );
    expect(fileNames.filter((name) => name.endsWith('svelte-jsx-v4.d.ts'))).toEqual([]);
    expect(fileNames.filter((name) => name.includes('svelte2tsx'))).toEqual([]);
  });

  it("bundles svelte2tsx with tsserver's TypeScript and no Svelte compiler: neither is in the pack", () => {
    const regions = [
      ...readFileSync(join(extension, 'dist', 'typescript-plugin.cjs'), 'utf8').matchAll(/^\/\/#region (.*)$/gm),
    ].map(([, path]) => path!);
    expect(regions).toEqual(expect.arrayContaining([expect.stringMatching(/\/svelte2tsx\/index\.mjs$/)]));
    expect(regions).toEqual(expect.arrayContaining(['packages/vscode/src/bundle/hostTypeScript.ts']));
    expect(regions.filter((path) => /\/node_modules\/(typescript|svelte)\//.test(path))).toEqual([]);
  });

  it("runs the build's attribute rewrite through oxc-parser's wasm binding: a non-literal attribute is its error", async () => {
    const {errors} = rewriteImportAttributes(NON_LITERAL.source, NON_LITERAL.filename);
    expect(await server.diagnostics(NON_LITERAL.filename)).toMatchObject([
      {code: 'framework-attribute-not-literal', category: 'error', text: errors[0]!.message},
    ]);
  });
});

describe("tsserver with the plugin pack and the project's own plugin: the first copy serves, the pack steps aside", () => {
  let server: Tsserver;
  let logFile: string;

  beforeAll(async () => {
    logFile = join(temp, 'both.log');
    // The project's own entry, found first in packages/e2e, runs from source.
    server = startTsserver({cwd: APP_DIR, plugins: [PACK], probeLocations: [E2E_DIR, extension], logFile});
    await open(server, [APP, CARD, MIXED]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('the pack logs that it steps aside', () => {
    const log = readFileSync(logFile, 'utf8');
    const loading = log.indexOf(`Loading global plugin ${PACK}`);
    expect(loading).toBeGreaterThan(-1);
    // The project's own entry loaded first, so the pack steps aside.
    expect(log.indexOf(STEPS_ASIDE, loading)).toBeGreaterThan(loading);
  });

  appTsxCases(() => server);

  it('mixed.ts: nothing on the vue import, one mixed-frameworks warning on the react one', async () => {
    const diagnostics = await server.diagnostics(MIXED.filename);
    const [vue, react] = MIXED_LINES;
    expect(codesOnLine(diagnostics, vue)).toEqual([]);
    expect(onLine(diagnostics, react)).toMatchObject([{code: 'mixed-frameworks', category: 'warning'}]);
  });
});

describe('mf-tsc and the plugin pack alone, on the same broken .ucf files', () => {
  // MarkupBreaks.ucf is Card.ucf as the milestone 7 exit test breaks it.
  const files = ['ReactBreaks.ucf', 'VueBreaks.ucf', 'SvelteBreaks.ucf', 'MarkupBreaks.ucf'];
  let root: string;

  beforeAll(async () => {
    root = await copyApp(BROKEN);
    addFile(root, 'MarkupBreaks.ucf', breakSvelteMarkup(readComponent('Card.ucf').source));
  });

  afterAll(async () => {
    if (root) await removeApp(root);
  });

  it('give the same codes at the same spans, a <svelte> markup attribute included', async () => {
    const {ours, theirs} = await bothHosts(root, files, {plugins: [PACK], probeLocations: [extension], isolated: true});
    expect(ours.map((found) => found.length)).toEqual([1, 1, 1, 1]);
    const byFile = (found: typeof ours) => Object.fromEntries(files.map((name, index) => [name, found[index]]));
    expect(byFile(theirs)).toEqual(byFile(ours));
  });
});
