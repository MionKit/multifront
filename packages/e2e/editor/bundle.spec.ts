import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EXPECTED_IMPORTS} from '../fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {APP, APP_DIR, appTsxCases, CARD, codesOnLine, onLine, readApp} from './lib/cases.ts';
import {languageServerCases} from './lib/cases.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {open, startTsserver} from './lib/tsserver.ts';
import type {Tsserver} from './lib/tsserver.ts';
import {tempRepo, unzipVsix} from './lib/vsix.ts';

const PROJECT_PLUGIN = '@multifront/language-tools/typescript-plugin';
const PACK = 'multifront-typescript-plugin-pack';
const E2E_DIR = join(import.meta.dirname, '..');
// What the extension passes the server as its tsdk: a TypeScript lib folder.
const TSDK = dirname(createRequire(import.meta.url).resolve('typescript'));
const STEPS_ASIDE = 'multifront: another copy of the TypeScript plugin already serves this project; this one steps aside';

// Packed in a temp copy, then unzipped: every check runs on what the .vsix ships, not on packages/vscode/dist.
let temp: string;
let extension: string;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-bundle-'));
  const root = tempRepo();
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'devx.mjs'), 'vsix'], {cwd: root, encoding: 'utf8'});
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await unzipVsix(join(root, 'packages', 'vscode', 'multifront-vscode-0.0.0.vsix'), temp);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
  extension = join(temp, 'extension');
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
    // Isolated: the project's own entry is found nowhere, so the pack is the one plugin.
    server = startTsserver({cwd: APP_DIR, plugins: [PACK], probeLocations: [extension], source: false, isolated: true, logFile});
    await open(server, [APP, CARD]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("the project's own plugin entry is not found; the pack loads", () => {
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain(`Failed to load module '${PROJECT_PLUGIN}'`);
    const loading = log.indexOf(`Loading global plugin ${PACK}`);
    expect(loading).toBeGreaterThan(-1);
    expect(log.indexOf('Plugin validation succeeded', loading)).toBeGreaterThan(loading);
    expect(log).not.toContain(`Failed to load module '${PACK}'`);
  });

  appTsxCases(() => server);
});

describe("tsserver with the plugin pack and the project's own plugin: the first copy serves, the pack steps aside", () => {
  const MIXED = readApp('src/mixed.ts');
  let server: Tsserver;
  let logFile: string;

  beforeAll(async () => {
    logFile = join(temp, 'both.log');
    // The project's entry runs from source, found in packages/e2e first; the pack is a global plugin.
    server = startTsserver({cwd: APP_DIR, plugins: [PACK], probeLocations: [E2E_DIR, extension], logFile});
    await open(server, [APP, CARD, MIXED]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('the pack logs that it steps aside', () => {
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain(`Loading global plugin ${PACK}`);
    expect(log).toContain(STEPS_ASIDE);
  });

  appTsxCases(() => server);

  it('mixed.ts: one target-not-built on the vue import, one mixed-frameworks warning on the react one', async () => {
    const diagnostics = await server.diagnostics(MIXED.filename);
    const [vue, react] = EXPECTED_IMPORTS.filter(({file}) => file === 'src/mixed.ts').map(({line}) => line);
    expect(codesOnLine(diagnostics, vue!)).toEqual(['target-not-built']);
    expect(onLine(diagnostics, react!)).toMatchObject([{code: 'mixed-frameworks', category: 'warning'}]);
  });
});
