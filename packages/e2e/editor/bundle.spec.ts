import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {
  APP,
  APP_DIR,
  appTsxCases,
  CARD,
  codesOnLine,
  languageServerCases,
  MIXED,
  MIXED_LINES,
  onLine,
  PLUGIN,
} from './lib/cases.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {E2E_DIR, open, startTsserver} from './lib/tsserver.ts';
import type {Tsserver} from './lib/tsserver.ts';
import {tempRepo, unzipVsix} from './lib/vsix.ts';

const PACK = 'multifront-typescript-plugin-pack';
// Stands in for the extension's tsdk: a TypeScript lib folder.
const TSDK = dirname(createRequire(import.meta.url).resolve('typescript'));
const STEPS_ASIDE = 'multifront: another copy of the TypeScript plugin already serves this project; this one steps aside';

// Every check runs on what the .vsix ships, not on packages/vscode/dist.
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
    // Isolated hides the project's own entry: the pack is the only plugin.
    server = startTsserver({cwd: APP_DIR, plugins: [PACK], probeLocations: [extension], isolated: true, logFile});
    await open(server, [APP, CARD]);
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

  it('mixed.ts: one target-not-built on the vue import, one mixed-frameworks warning on the react one', async () => {
    const diagnostics = await server.diagnostics(MIXED.filename);
    const [vue, react] = MIXED_LINES;
    expect(codesOnLine(diagnostics, vue)).toEqual(['target-not-built']);
    expect(onLine(diagnostics, react)).toMatchObject([{code: 'mixed-frameworks', category: 'warning'}]);
  });
});
