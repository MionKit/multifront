// Seam of 3.6 (the scan plugin) and 3.7 (the attribute): a bare import found only in a `<react>` block is optimized
// at startup, whichever rule of spec 4.2 picked react for the importer.
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createLogger, createServer, type ViteDevServer} from 'vite';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'scan-deps');

// [entry, the rule that picks react]; `Mount.ucf`'s block is the only importer of `react-dom/client`.
const ENTRIES: [string, string][] = [
  ['bare.tsx', 'importer'],
  ['attribute.ts', 'attribute'],
  ['inline.html', 'attribute'],
  ['tsx-script.vue', 'attribute'],
];

describe('dependency scan of scan-deps', () => {
  it.each(ENTRIES)('%s (%s rule): finds react-dom/client, imported only inside the <react> block', async (entry) => {
    const errors: string[] = [];
    const logger = createLogger('silent');
    logger.error = (message) => void errors.push(message);
    await mkdir(TMP_DIR, {recursive: true});
    const cacheDir = await mkdtemp(join(TMP_DIR, 'scan-deps-cache-'));
    let server: ViteDevServer | undefined;
    try {
      server = await createServer({
        root: ROOT,
        configLoader: APP_CONFIG_LOADER,
        cacheDir,
        customLogger: logger,
        server: {middlewareMode: true, ws: false},
        optimizeDeps: {entries: [entry]},
      });
      const optimizer = server.environments.client.depsOptimizer!;
      await optimizer.scanProcessing;
      expect({entry, errors}).toEqual({entry, errors: []});
      expect({entry, discovered: Object.keys(optimizer.metadata.discovered)}).toEqual({
        entry,
        discovered: expect.arrayContaining(['react-dom/client']),
      });
    } finally {
      try {
        await server?.environments.client.waitForRequestsIdle();
        await server?.close();
      } finally {
        await rm(cacheDir, {recursive: true, force: true});
      }
    }
  });
});
