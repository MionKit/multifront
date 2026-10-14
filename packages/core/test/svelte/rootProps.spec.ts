// Spec 3.6, root props: a forwarded Svelte root takes and merges the parent's `class` and `style`, typed for the editor.
import {basename} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {svelteEditorSource} from '@multifront/core';
import type {AST} from 'svelte/compiler';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents} from '../../../e2e/fixtures/index.ts';
import {removeRendered, renderBuild, startTags, svelte, svelteBuild} from './render.ts';

afterAll(removeRendered);

const ROOT_PROPS_DIR = 'svelte/root-props';
const PARENT = {class: 'parent-extra', style: 'color: red'};
const TYPE = "{class?: import('svelte/elements').ClassValue | null; style?: string | null}";

type RootProp = keyof typeof PARENT;
// How the build left a root's `class` or `style`.
type State = 'added' | 'merged' | 'author' | 'none';
type Node = AST.BaseNode & Record<string, unknown>;

// Hand-read from the fixtures. `roots`: per forwarded root in source order; `typed`: the `$props()` text of the library
// build and the editor source; `renders`: the props of each server render over the parent's (none with
// `parent: false`), and the root's class list and style.
type Render = {props?: Record<string, unknown>; parent?: false; classes: string[]; style?: string};
type Row = {fixture: string; roots: Record<RootProp, State>[]; typed: string; renders: Render[]};

const ROWS: Row[] = (
  [
    {
      fixture: 'DestructuresClass.ucf',
      roots: [{class: 'author', style: 'author'}],
      typed: "let { class: klass = '', style, ...__ucfRest }: { class?: string; style?: string } = $props()",
      renders: [{classes: ['own', 'parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'JsDoc.ucf',
      roots: [{class: 'merged', style: 'merged'}],
      typed: `/** @type {({ label?: string }) & ${TYPE}} */\n    let { label = 'jsdoc', ...__ucfRest } = $props()`,
      renders: [{classes: ['own', 'parent-extra'], style: 'padding: 1px; color: red'}],
    },
    {
      fixture: 'JsNoProps.ucf',
      roots: [{class: 'merged', style: 'added'}],
      typed: `/** @type {${TYPE}} */ let {...__ucfRest} = $props();`,
      renders: [{classes: ['own', 'parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'Merges.ucf',
      roots: [
        {class: 'merged', style: 'merged'},
        {class: 'merged', style: 'merged'},
        {class: 'merged', style: 'merged'},
        {class: 'merged', style: 'added'},
        {class: 'merged', style: 'added'},
      ],
      typed: `let { branch, tone = 'calm', ...__ucfRest }: ({ branch: string; tone?: string }) & ${TYPE} = $props()`,
      renders: [
        {props: {branch: 'text'}, classes: ['own', 'text', 'parent-extra'], style: 'padding: 4px;; color: red'},
        // A class value Svelte flattens, as on an element.
        {
          props: {branch: 'text', class: ['x', {y: true, z: false}]},
          classes: ['own', 'text', 'x', 'y'],
          style: 'padding: 4px;; color: red',
        },
        // An object is no Svelte style: the root keeps its own.
        {
          props: {branch: 'text', style: {padding: '6px'}},
          classes: ['own', 'text', 'parent-extra'],
          style: 'padding: 4px;; [object Object]',
        },
        {props: {branch: 'mixed'}, classes: ['own', 'calm', 'parent-extra'], style: 'margin: 1px; color: red'},
        {props: {branch: 'expression'}, classes: ['own', 'calm', 'parent-extra'], style: 'padding: 2px; color: red'},
        {props: {branch: 'escaped'}, classes: ['a\\b', '`c`', '${d', 'calm', 'parent-extra'], style: 'color: red'},
        // Svelte's `style:` directive wins over the parent's style.
        {props: {branch: 'directive'}, classes: ['own-calm', 'parent-extra'], style: 'color: blue;'},
        // With no parent's style, an added one leaves no attribute.
        {props: {branch: 'directive'}, parent: false, classes: ['own-calm'], style: 'color: blue;'},
        {props: {branch: 'escaped'}, parent: false, classes: ['a\\b', '`c`', '${d', 'calm']},
      ],
    },
    {
      fixture: 'MergesOnComponent.ucf',
      roots: [{class: 'merged', style: 'merged'}],
      typed: `let { tag = 'aside', ...__ucfRest }: ({ tag?: string }) & ${TYPE} = $props()`,
      // SvelteElementRoot merges again: its own class first, then the one this root passed on.
      renders: [{classes: ['shape', 'own', 'parent-extra'], style: 'padding: 1px; color: red'}],
    },
    {
      fixture: 'ReadsCast.ucf',
      roots: [{class: 'author', style: 'author'}],
      typed: 'let props: Props = $props()',
      renders: [{classes: ['own', 'parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'ReadsClass.ucf',
      roots: [{class: 'author', style: 'added'}],
      typed: 'let props: ({ label?: string; class?: string }) & {style?: string | null} = $props()',
      renders: [{classes: ['own', 'parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'ReadsDestructure.ucf',
      roots: [{class: 'author', style: 'author'}],
      typed: "let { label = 'destructure', ...rest }: { label?: string; class?: string; style?: string } = $props()",
      renders: [{classes: ['own', 'parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'ReadsOptional.ucf',
      roots: [{class: 'author', style: 'author'}],
      typed: 'let props: { label?: string; class?: string; style?: string } = $props()',
      renders: [{classes: ['own', 'parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'SpreadsRest.ucf',
      roots: [{class: 'author', style: 'none'}],
      typed: "let { label = 'spreads', ...rest }: { label?: string; [key: string]: unknown } = $props()",
      renders: [{classes: ['parent-extra'], style: 'color: red'}],
    },
    {
      fixture: 'Untyped.ucf',
      roots: [{class: 'merged', style: 'added'}],
      typed: "let { label = 'untyped', ...__ucfRest } = $props()",
      renders: [
        {classes: ['own', 'parent-extra'], style: 'color: red'},
        {parent: false, classes: ['own']},
      ],
    },
    {
      fixture: 'ValuelessClass.ucf',
      roots: [{class: 'author', style: 'merged'}],
      typed: `let { label = 'valueless', ...__ucfRest }: ({ label?: string }) & {style?: string | null} = $props()`,
      // Left as written; beside the scope spread, Svelte renders a `class` with no value as `class="true"`.
      renders: [{classes: ['true'], style: 'padding: 1px; color: red'}],
    },
  ] satisfies Row[]
).map((row) => ({...row, fixture: `${ROOT_PROPS_DIR}/${row.fixture}`}));

it('has a row for every svelte/root-props/ fixture', () => {
  expect(listComponents(ROOT_PROPS_DIR)).toEqual(ROWS.map(({fixture}) => fixture));
});

function visit(value: unknown, enter: (node: Node) => void): void {
  if (Array.isArray(value)) return value.forEach((item) => visit(item, enter));
  if (!value || typeof value !== 'object') return;
  if (typeof (value as Node).type === 'string') enter(value as Node);
  for (const child of Object.values(value)) visit(child, enter);
}

// The roots the build spread the parent's scope on, and the props name it reads.
// `added`: the root props the spread passes on.
function forwardedRoots(code: string): {root: Node; props: string; added: string[]}[] {
  const found: {root: Node; props: string; added: string[]}[] = [];
  visit(svelte.parse(code, {modern: true}).fragment, (node) => {
    for (const attribute of (node.attributes as Node[] | undefined) ?? []) {
      const spread = /^\{\.\.\.__ucfScopeAttrs\d*\((\w+)((?:, '\w+')*)\)\}$/.exec(code.slice(attribute.start, attribute.end));
      if (attribute.type === 'SpreadAttribute' && spread)
        found.push({root: node, props: spread[1]!, added: [...spread[2]!.matchAll(/'(\w+)'/g)].map(([, key]) => key!)});
    }
  });
  return found;
}

function state(code: string, {root, props, added}: ReturnType<typeof forwardedRoots>[number], prop: RootProp): State {
  if (added.includes(prop)) return 'added';
  const own = (root.attributes as Node[]).find(({type, name}) => type === 'Attribute' && name === prop);
  if (!own) return 'none';
  const value = code.slice(own.start, own.end);
  const merge = prop === 'class' ? '__ucfSvelteClass' : '__ucfStyle';
  return new RegExp(String.raw`^${prop}=\{${merge}\d*\(.*, ${props}\.${prop}\)\}$`, 's').test(value) ? 'merged' : 'author';
}

describe.each(ROWS)('svelte.build root props of $fixture', async ({fixture, roots, typed, renders}) => {
  const dev = await svelteBuild(fixture);
  const production = await svelteBuild(fixture, true);
  const name = basename(fixture, '.ucf');

  it('builds in dev and in production, and Svelte compiles both with no warning', () => {
    for (const {file, ctx} of [dev, production]) {
      for (const generate of ['server', 'client'] as const) {
        const {warnings} = svelte.compile(file!.code, {generate, filename: `${ctx.filename}.svelte.svelte`});
        expect(warnings.map(({code, message}) => `${code}: ${message}`)).toEqual([]);
      }
    }
  });

  it('matches the dev code snapshot', async () => {
    await expect(dev.file!.code.replaceAll(FIXTURES_DIR, '<fixtures>')).toMatchFileSnapshot(
      `../__snapshots__/${fixture}.svelte.snap`
    );
  });

  it('adds, merges or leaves class and style on each root, in dev and in production', () => {
    for (const {file} of [dev, production]) {
      const found = forwardedRoots(file!.code).map((root) => ({
        class: state(file!.code, root, 'class'),
        style: state(file!.code, root, 'style'),
      }));
      expect(found).toEqual(roots);
    }
  });

  it("types the props the same in the library build and the editor source, and leaves an app's untyped", async () => {
    const {split, ctx} = dev;
    const library = await svelteBuild(fixture, true, {src: componentPath('')});
    const editor = svelteEditorSource(split.targets.svelte!, split, svelte, ctx.modules).code;
    for (const code of [library.file!.code, editor]) expect(code).toContain(typed);
    for (const {file} of [dev, production]) expect(file!.code).not.toContain("import('svelte/elements')");
  });

  it.each(renders)("renders the parent's class and style on the root: %o", async (row) => {
    const {props, parent, classes, style} = row;
    const passed = {...(parent === false ? {} : PARENT), ...props};
    const {body} = await renderBuild(dev.file!, dev.ctx, `${name}.${renders.indexOf(row)}`, passed);
    const [root] = startTags(body, 'data-none');
    expect({classes: root!.classes, style: root!.style}).toEqual({classes, style});
  });
});
