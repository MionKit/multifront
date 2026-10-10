import {rm} from 'node:fs/promises';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp} from '../fixtures/index.ts';
import {buildApp, exportedScopeId} from './lib/build.ts';

let root: string;

beforeAll(async () => {
  root = await copyApp('vue-reference');
  return () => rm(root, {recursive: true, force: true});
});

// Each rule's selector, plus the one attribute selector plugin-vue may append.
function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[},])\\s*(${escaped}(?:\\[[^\\]]+\\])?)\\s*\\{`, 'gm'))].map((match) => match[1]!);
}

describe('vue-reference app, built by plugin-vue alone', () => {
  it('stamps one scope id on the component and on its scoped CSS', async () => {
    const {chunks, css: sheets} = await buildApp(root);
    expect(chunks).toHaveLength(1);
    expect(sheets).toHaveLength(1);

    const scopeId = exportedScopeId(chunks[0]!.code);
    expect(scopeId).toMatch(/^data-v-[0-9a-f]{8}$/);

    const css = sheets[0]!;
    expect(new Set(css.match(/data-v-[0-9a-f]+/g))).toEqual(new Set([scopeId]));
    expect(rulesFor(css, '.title')).toEqual([`.title[${scopeId}]`]);
    expect(rulesFor(css, '.box')).toEqual([`.box[${scopeId}]`]);
    expect(rulesFor(css, '.box .inner')).toEqual([`.box .inner[${scopeId}]`]);
    expect(css).toMatch(/\.[\w-]*note[\w-]*\s*\{\s*font-style: italic;/);
  });
});
