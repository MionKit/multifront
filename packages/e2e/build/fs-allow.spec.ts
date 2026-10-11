// The dev server answers 403 for a file outside `server.fs.allow`; our ids of that file must not serve its blocks.
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR, componentPath} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'react-basic');
// The shared components sit beside the app, outside the one allowed folder.
const CARD = componentPath('Card.ucf');

describe('dev server of react-basic with server.fs.allow set to the app folder', () => {
  let server: ViteDevServer | undefined;
  let cacheDir: string | undefined;
  let base = '';

  beforeAll(async () => {
    await mkdir(TMP_DIR, {recursive: true});
    cacheDir = await mkdtemp(join(TMP_DIR, 'fs-allow-cache-'));
    server = await createServer({
      root: ROOT,
      configLoader: APP_CONFIG_LOADER,
      cacheDir,
      logLevel: 'silent',
      server: {port: 0, fs: {strict: true, allow: [ROOT]}},
      optimizeDeps: {noDiscovery: true, include: []},
    });
    await server.listen();
    base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
  });

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      if (cacheDir) await rm(cacheDir, {recursive: true, force: true});
    }
  });

  it.each([
    ['the .ucf file itself (Vite checks it)', `/@fs${CARD}`],
    ['its React module', `/@fs${CARD}.react.tsx`],
    ['its React module, as an absolute URL', `${CARD}.react.tsx`],
    ['its style module', `/@fs${CARD}?ucf&type=style&index=0&lang.css`],
    ['its class map module', `/@fs${CARD}?ucf&type=style&index=0&module&lang.js`],
  ])('%s: 403', async (_what, path) => {
    const response = await fetch(base + path);
    expect({path, status: response.status}).toEqual({path, status: 403});
  });

  it('still loads its React module in SSR, which Vite does not check either', async () => {
    const result = await server!.environments.ssr.transformRequest(`${CARD}.react.tsx`);
    expect(result?.code).toContain('function Card(');
  });
});
