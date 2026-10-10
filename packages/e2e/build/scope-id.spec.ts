import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {scopeId} from '@multifront/core';
import {createServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp} from '../fixtures/index.ts';
import {buildApp, exportedScopeId} from './lib/build.ts';

const FILE = 'src/Reference.vue';
let root: string;
let source: string;

beforeAll(async () => {
  root = await copyApp('vue-reference');
  source = await readFile(join(root, FILE), 'utf8');
  return () => rm(root, {recursive: true, force: true});
});

describe('scopeId, against plugin-vue with no componentIdGenerator', () => {
  it('gives the id of a production build', async () => {
    const expected = `data-v-${scopeId(FILE, source, true)}`;
    const {chunks, cssAssets} = await buildApp(root);
    expect(chunks).toHaveLength(1);
    expect(exportedScopeId(chunks[0]!.code)).toBe(expected);
    expect(cssAssets).toHaveLength(1);
    expect(new Set(cssAssets[0]!.css.match(/data-v-[0-9a-f]+/g))).toEqual(new Set([expected]));
  });

  it('gives the id of the dev server', async () => {
    // Vitest's NODE_ENV=test makes plugin-vue take its dev path (isProduction false).
    const server = await createServer({root, logLevel: 'silent', server: {middlewareMode: true, ws: false}});
    try {
      const result = await server.transformRequest(`/${FILE}`);
      expect(exportedScopeId(result?.code ?? '')).toBe(`data-v-${scopeId(FILE, source, false)}`);
    } finally {
      await server.close();
    }
  });

  it('hashes the source only in production', () => {
    expect(scopeId(FILE, source, false)).not.toBe(scopeId(FILE, source, true));
  });
});
