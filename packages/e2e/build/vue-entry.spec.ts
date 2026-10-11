// QA seam (4.4 + M3's framework option): a `.ucf` file as a library entry, with no importer, built as Vue.
// M5's Vue package is this build: `multifront({framework: 'vue'})` plus `vue()` on `.ucf` entries.
import {join} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {moduleClassName} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath} from '../fixtures/index.ts';
import {scopeAttribute} from '../browser/lib/scope.ts';
import {buildApp, rejection} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'vue');
const COUNTER = componentPath('Counter.ucf');

// A library build keeps the entry's exports; an app build drops them, and the component with them.
const libraryBuild = (entry: string) =>
  buildApp(ROOT, {
    configFile: false,
    plugins: [vue(), multifront({framework: 'vue'})],
    build: {lib: {entry, formats: ['es'], fileName: 'counter'}, rolldownOptions: {external: ['vue']}},
  });

describe('a .ucf entry in a library build with framework: vue', () => {
  it('compiles the <vue> block with plugin-vue: our scope id and $style names, no <react> text', async () => {
    const {chunks, css} = await libraryBuild(COUNTER);
    const code = chunks.map((chunk) => chunk.code).join('\n');
    const scope = scopeAttribute(ROOT, COUNTER, true);
    expect(code).toMatch(/__name: "Counter"/);
    expect(code).toContain('createElementBlock("div"');
    expect(code).not.toContain('useState');
    expect(code).toContain(`["__scopeId", "${scope}"]`);
    expect(css.join('\n')).toContain(`.counter[${scope}]`);
    expect(css.join('\n')).toContain(`.${moduleClassName('button', scope.slice('data-v-'.length), 1)}`);
  });

  it('names the file alone when the entry has no <vue> block', async () => {
    const input = componentPath('imports/ReactOnly.ucf');
    const err = await rejection<Error>(libraryBuild(input));
    expect(err.message).toContain(`${input} has no <vue> block (missing-target-block)`);
  });
});
