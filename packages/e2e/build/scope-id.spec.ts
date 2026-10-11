import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {scopeId} from '@multifront/core';
import {createServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp, exportedScopeId, withNodeEnv} from './lib/build.ts';

const FILE = 'src/Reference.vue';
let root: string;
let source: string;

beforeAll(async () => {
  root = await copyApp('vue-reference');
  source = await readFile(join(root, FILE), 'utf8');
  return () => removeApp(root);
});

describe('scopeId, against plugin-vue with no componentIdGenerator', () => {
  it('gives the id of a production build', async () => {
    const {chunks} = await buildApp(root);
    expect(exportedScopeId(chunks[0]!.code)).toBe(`data-v-${scopeId(FILE, source, true)}`);
  });

  it('gives the id of the dev server', async () => {
    const code = await withNodeEnv('development', async () => {
      // No dep optimizer: when it finishes before transformRequest under load, the request never resolves.
      const server = await createServer({
        root,
        logLevel: 'silent',
        server: {middlewareMode: true, ws: false},
        optimizeDeps: {noDiscovery: true},
      });
      try {
        return (await server.transformRequest(`/${FILE}`))?.code;
      } finally {
        await server.close();
      }
    });
    expect(exportedScopeId(code ?? '')).toBe(`data-v-${scopeId(FILE, source, false)}`);
  });

  it('hashes the source only in production', () => {
    expect(scopeId(FILE, source, false)).not.toBe(scopeId(FILE, source, true));
  });
});
