// Scan plugin (3.6) meets attribute (3.7): a bare import only the picked block has is optimized at startup.
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createLogger, createServer, type ViteDevServer} from 'vite';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'scan-deps');

const REACT_DEPENDENCY = 'react-dom/client';
const VUE_DEPENDENCY = '@jridgewell/trace-mapping';

// [entry, the rule that picks the framework, the dependency only that block of `Mount.ucf` imports, the other one].
const ENTRIES: [string, string, string, string][] = [
  ['bare.tsx', 'importer', REACT_DEPENDENCY, VUE_DEPENDENCY],
  ['attribute.ts', 'attribute', REACT_DEPENDENCY, VUE_DEPENDENCY],
  ['inline.html', 'attribute', REACT_DEPENDENCY, VUE_DEPENDENCY],
  ['tsx-script.vue', 'attribute', REACT_DEPENDENCY, VUE_DEPENDENCY],
  ['importer.vue', 'importer', VUE_DEPENDENCY, REACT_DEPENDENCY],
  ['vue-edges.vue', 'importer', VUE_DEPENDENCY, REACT_DEPENDENCY],
];

describe('dependency scan of scan-deps', () => {
  it.each(ENTRIES)('%s (%s rule): finds %s, imported only inside the picked block', async (entry, _rule, found, other) => {
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
      const discovered = Object.keys(optimizer.metadata.discovered);
      expect({entry, discovered}).toEqual({entry, discovered: expect.arrayContaining([found])});
      expect(discovered).not.toContain(other);
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
