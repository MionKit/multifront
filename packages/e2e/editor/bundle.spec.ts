import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rewriteImportAttributes} from '@multifront/core';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
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
import type {LanguageServer} from './lib/lsp.ts';
import {E2E_DIR, locate, open, startTsserver} from './lib/tsserver.ts';
import type {TsQuickInfo, Tsserver} from './lib/tsserver.ts';
import {packVsix, REPO_ROOT} from './lib/vsix.ts';

const PACK = 'multifront-typescript-plugin-pack';
const NON_LITERAL = readApp('no-default/non-literal.ts');
const VUE_PICK = readApp('no-default/attribute-over-importer.tsx');
const SVELTE_PICK = readApp('src/lazy.ts');
const GLOBAL_TYPES = ['template-helpers.d.ts', 'props-fallback.d.ts'];
const SVELTE_SHIMS = ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts'];
const STEPS_ASIDE = 'multifront: another copy of the TypeScript plugin already serves this project; this one steps aside';

// Every check runs on what the .vsix ships, not on packages/vscode/dist.
let temp: string;
let extension: string;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-bundle-'));
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
    for (const name of SVELTE_SHIMS) expect(fileNames).toContain(join(extension, 'dist', 'svelte-types', name));
    // The shims' `import('svelte')` reads the project's Svelte: beside the bundle there is none.
    const svelteTypes = fileNames.filter((name) => name.endsWith('/svelte/types/index.d.ts')).map((name) => realpathSync(name));
    expect(svelteTypes).toEqual([realpathSync(join(REPO_ROOT, 'node_modules', 'svelte', 'types', 'index.d.ts'))]);
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
