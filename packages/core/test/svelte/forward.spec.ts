import {readFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {rootRelativePath, scopeId} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, listComponents} from '../../../e2e/fixtures/index.ts';
import {removeRendered, renderBuild, startTags, svelte, svelteBuild} from './render.ts';

afterAll(removeRendered);

const ROOTS_DIR = 'svelte/roots';
const ROOTS_PARENT = join(FIXTURES_DIR, 'apps', 'all-targets', 'Roots.ucf');
// The scope prop Roots.ucf's stamp passes each child, in dev.
const PARENT_SCOPE = `data-v-${scopeId(rootRelativePath(FIXTURES_DIR, ROOTS_PARENT), readFileSync(ROOTS_PARENT, 'utf8'), false)}`;

const LEGACY = ['is a legacy-mode Svelte component', 'Use $props() to make it a runes-mode component.'];

// Hand-read from the fixtures: `from` is the props name each root spreads, `roots` its element roots in all branches.
// `renders`: the props of each server render, `html`: what it holds; a `problem` row warns, `svelteError` is Svelte's.
// `helper`: the local the spread calls, when the block already uses the helper's name.
type RootShape = {
  fixture: string;
  from?: string;
  helper?: string;
  roots?: number;
  problem?: string[];
  unchanged?: true;
  svelteError?: string;
  renders: Record<string, unknown>[];
  html?: string[];
};

const ROOT_SHAPES: RootShape[] = (
  [
    {fixture: 'EachRoot.ucf', problem: ['renders an {#each} block as its root'], renders: [{}]},
    // The name `__ucfRest` is taken; `let {} = $props()` gains the rest.
    {fixture: 'EmptyPropsRoot.ucf', from: '__ucfRest1', roots: 1, renders: [{}]},
    // `<svelte:options runes />`, an empty instance script.
    {fixture: 'EmptyScriptRoot.ucf', from: '__ucfRest', roots: 1, renders: [{}]},
    // Escaped once, as with no spread.
    {
      fixture: 'EscapedRoot.ucf',
      from: '__ucfRest',
      roots: 1,
      renders: [{}],
      html: ['title="a &amp; b"', 'data-html="&lt;div>"', 'data-quote="&quot;quoted&quot;"', 'data-mixed="&amp; escaped"'],
    },
    // Declares `__ucfScopeAttrs`: the helper is imported under the next free name.
    {fixture: 'HelperClashRoot.ucf', from: '__ucfRest', helper: '__ucfScopeAttrs1', roots: 1, renders: [{}], html: ['clash own']},
    // A comment before the trailing comma of its `$props()` pattern, a `{@const}` beside a root.
    {fixture: 'IfElseRoot.ucf', from: '__ucfRest', roots: 3, renders: [{branch: 'a'}, {branch: 'b'}, {branch: 'c'}]},
    {fixture: 'LegacyRoot.ucf', problem: LEGACY, renders: [{}]},
    // `$state` of a store, rune names as property names: still legacy.
    {fixture: 'LegacyStoreRoot.ucf', problem: LEGACY, renders: [{}]},
    // An element root beside a text root; a line comment before the trailing comma.
    {fixture: 'MultiRoot.ucf', problem: ['renders more than one root'], renders: [{}]},
    // Through `{#key}`, `<svelte:boundary>` and its `failed` snippet, `{#if}` and every `{#await}` branch.
    {fixture: 'NestedRoot.ucf', from: 'props', roots: 5, renders: [{value: 'server'}]},
    // No `$props()`: one is added.
    {fixture: 'NoPropsRoot.ucf', from: '__ucfRest', roots: 1, renders: [{}]},
    // `<svelte:options runes />` and no script: one is added.
    {fixture: 'OptionsRoot.ucf', from: '__ucfRest', roots: 1, renders: [{}]},
    // Its root is another `.ucf` component, which takes the scope on.
    {fixture: 'PassOnRoot.ucf', from: '__ucfRest', roots: 1, renders: [{}]},
    // `let props = $props()` is its only rune.
    {fixture: 'PropsOnlyRoot.ucf', from: 'props', roots: 1, renders: [{}]},
    // `$props()` in the second declarator of a `const`.
    {fixture: 'RestRoot.ucf', from: 'rest', roots: 1, renders: [{note: 'rest note'}]},
    // `{:then props}` hides the props: an alias reads them.
    {fixture: 'ShadowRoot.ucf', from: '__ucfProps', roots: 1, renders: [{}]},
    // `$derived` beside svelte/store's `derived` is a rune.
    {fixture: 'StoreDerivedRoot.ucf', from: '__ucfRest', roots: 1, renders: [{}]},
    {fixture: 'StringHandlerRoot.ucf', from: '__ucfRest', roots: 1, svelteError: 'attribute_invalid_event_handler', renders: []},
    {fixture: 'SvelteElementRoot.ucf', from: '__ucfRest', roots: 1, renders: [{}, {tag: 'aside'}], html: ['title="a &amp; b"']},
    // No element root: nothing to forward to, nothing to warn about.
    {fixture: 'TextRoot.ucf', unchanged: true, renders: []},
  ] satisfies RootShape[]
).map((row) => ({...row, fixture: `${ROOTS_DIR}/${row.fixture}`}));

it('has a row for every svelte/roots/ fixture', () => {
  expect(listComponents(ROOTS_DIR)).toEqual(ROOT_SHAPES.map(({fixture}) => fixture));
});

describe.each(ROOT_SHAPES)('svelte.build forwarding of $fixture', async (row) => {
  const {fixture, from, helper = '__ucfScopeAttrs', roots, problem, unchanged, svelteError, renders, html} = row;
  const dev = await svelteBuild(fixture);
  const production = await svelteBuild(fixture, true);
  const name = basename(fixture, '.ucf');

  it(`builds in dev and in production, and Svelte compiles both ${svelteError ? `with its ${svelteError}` : 'with no warning'}`, () => {
    for (const {file, ctx} of [dev, production]) {
      for (const generate of ['server', 'client'] as const) {
        const compile = () => svelte.compile(file!.code, {generate, filename: `${ctx.filename}.svelte.svelte`});
        if (svelteError) expect(compile).toThrow(expect.objectContaining({code: svelteError}));
        else expect(compile().warnings.map(({code, message}) => `${code}: ${message}`)).toEqual([]);
      }
    }
  });

  it('matches the dev code snapshot', async () => {
    await expect(dev.file!.code.replaceAll(FIXTURES_DIR, '<fixtures>')).toMatchFileSnapshot(
      `../__snapshots__/${fixture}.svelte.snap`
    );
  });

  if (unchanged) {
    it('builds as written', () => {
      for (const {file, split} of [dev, production]) expect(file!.code).toBe(split.targets.svelte!.content);
    });
  } else if (problem) {
    it('forwards nothing, and warns in dev only, naming the file, why and the fix', () => {
      const props = problem === LEGACY ? '$$props' : '__ucfRest';
      const args = [name, ...problem].map((part) => JSON.stringify(part)).join(', ');
      expect(dev.file!.code).toContain(`__ucfWarnFragment(${props}, ${args})`);
      for (const {file} of [dev, production]) expect(file!.code).not.toContain('__ucfScopeAttrs');
      expect(production.file!.code).not.toMatch(/scope-attrs|__ucfRest|__ucfWarnFragment/);
    });
  } else {
    it(`spreads the parent's scope from ${from} on each of its ${roots} roots, in dev and in production`, () => {
      for (const {file} of [dev, production]) {
        expect(file!.code.split(`{...${helper}(${from})}`)).toHaveLength(roots! + 1);
        expect(file!.code.split(`${helper}(`)).toHaveLength(roots! + 1);
        expect(file!.code).not.toContain('__ucfWarnFragment');
      }
    });
  }

  it.each(renders)(`renders the parent's scope ${problem ? 'nowhere' : 'on the root only'}, with props %o`, async (props) => {
    const {body} = await renderBuild(dev.file!, dev.ctx, `${name}.${renders.indexOf(props)}`, {...props, [PARENT_SCOPE]: ''});
    const tags = startTags(body, PARENT_SCOPE);
    expect(tags.length).toBeGreaterThan(0);
    for (const {name: tag, top, stamps} of tags) expect({tag, top, stamps}).toEqual({tag, top, stamps: top && !problem ? 1 : 0});
    for (const attribute of html ?? []) expect(body).toContain(attribute);
  });
});
