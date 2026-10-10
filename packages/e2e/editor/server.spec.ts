import {join} from 'node:path';
import {afterAll, beforeAll} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {languageServerCases} from './lib/cases.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';

let server: LanguageServer;

beforeAll(async () => {
  server = await startLanguageServer(join(FIXTURES_DIR, 'components'));
});

afterAll(async () => {
  await server?.stop();
});

languageServerCases(() => server);
