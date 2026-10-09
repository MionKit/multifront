import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build, type Rolldown} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp} from '../fixtures/index.ts';

let root: string;

beforeAll(async () => {
  root = await copyApp('vue-reference');
});

afterAll(async () => {
  await rm(root, {recursive: true, force: true});
});

async function buildApp(): Promise<Rolldown.RolldownOutput['output']> {
  const result = await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: {write: false, minify: false},
  });
  const output = Array.isArray(result) ? result[0]! : result;
  if (!('output' in output)) throw new Error('vite.build() returned a watcher');
  return output.output;
}

// The rules of one selector, with whatever attribute selectors plugin-vue appended to it.
function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[},])\\s*(${escaped}(?:\\[[^\\]]+\\])?)\\s*\\{`, 'gm'))].map((match) => match[1]!);
}

describe('vue-reference app, built by plugin-vue alone', () => {
  it('stamps one scope id on the component and on its scoped CSS', async () => {
    const output = await buildApp();
    const chunks = output.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk');
    const cssAssets = output.filter(
      (file): file is Rolldown.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css')
    );
    expect(chunks).toHaveLength(1);
    expect(cssAssets).toHaveLength(1);

    const scopeId = /\[\s*["']__scopeId["']\s*,\s*["'](data-v-[0-9a-f]+)["']\s*\]/.exec(chunks[0]!.code)?.[1];
    expect(scopeId).toMatch(/^data-v-[0-9a-f]{8}$/);

    const asset = cssAssets[0]!;
    const css = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
    expect(new Set(css.match(/data-v-[0-9a-f]+/g))).toEqual(new Set([scopeId]));
    expect(rulesFor(css, '.title')).toEqual([`.title[${scopeId}]`]);
    expect(rulesFor(css, '.box')).toEqual([`.box[${scopeId}]`]);
    expect(rulesFor(css, '.box .inner')).toEqual([`.box .inner[${scopeId}]`]);
    expect(css).toMatch(/\.[\w-]*note[\w-]*\s*\{\s*font-style: italic;/);
  });
});
