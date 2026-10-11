import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {scopeId} from '@multifront/core';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp, exportedScopeId, withDevServer} from './lib/build.ts';

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
    const code = await withDevServer(root, {}, async (server) => (await server.transformRequest(`/${FILE}`))?.code);
    expect(exportedScopeId(code ?? '')).toBe(`data-v-${scopeId(FILE, source, false)}`);
  });

  it('hashes the source only in production', () => {
    expect(scopeId(FILE, source, false)).not.toBe(scopeId(FILE, source, true));
  });
});
