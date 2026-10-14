// Spec 2: `v-bind()` and `:slotted()` in CSS work in Vue only, so a file with other targets fails there, not silently.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkBlocks, splitBlocks} from '@multifront/core';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {buildApp} from './lib/build.ts';

const FIXTURE = 'invalid/VueOnlyStyle.ucf';

type BuildError = Error & {errors?: {loc?: unknown}[]};

let root: string;

beforeAll(async () => {
  root = await copyApp('all-targets');
});

afterAll(async () => {
  if (root) await removeApp(root);
});

async function build(framework: string) {
  const entry = join(root, 'src', `vue-only-style-${framework}.ts`);
  const specifier = `../../../components/${FIXTURE}`;
  await writeFile(entry, `import C from '${specifier}' with {framework: '${framework}'};\nconsole.log(C);\n`);
  return buildApp(root, {build: {rolldownOptions: {input: entry}}});
}

describe(`a build of ${FIXTURE}`, () => {
  const {filename, source} = readComponent(FIXTURE);
  const diagnostics = checkBlocks(splitBlocks(source, filename));
  const copied = (diagnostic: (typeof diagnostics)[number]) => ({
    file: join(root, '..', '..', 'components', FIXTURE),
    line: diagnostic.line,
    column: diagnostic.column,
  });

  it.each(['react', 'svelte'])('fails the %s target at a v-bind() or :slotted() spot of its style modules', async (framework) => {
    const err = (await build(framework).then(
      () => new Error('built'),
      (failure: unknown) => failure
    )) as BuildError;
    expect(err.message).toContain('(vue-only-style)');
    expect(err.message).toMatch(/(v-bind\(\)|:slotted\(\)) in <style( scoped)?> works in <vue> only, not in <react> or <svelte>/);
    expect(diagnostics.map(copied)).toContainEqual(err.errors?.[0]?.loc);
  });

  it('builds the vue target, which sets the variables and marks slot content itself', async () => {
    const {css} = await build('vue');
    const text = css.join('\n');
    expect(text).toMatch(/color:\s*var\(--[\w-]+\)/);
    expect(text).toMatch(/\.a\[data-v-[0-9a-f]+-s\]/);
    expect(text).toMatch(/\.b\[data-v-[0-9a-f]+-s\]/);
  });
});
