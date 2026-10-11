import {readFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import type {Browser, Locator, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {scopeId} from '@multifront/core';
import {FIXTURES_DIR, componentPath} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'react-scope');
const STAMPED = componentPath('react/scope/Stamped.ucf');
const PARENT = join(ROOT, 'Parent.ucf');
const MULTI_RETURN = componentPath('react/shapes/MultiReturn.ucf');

// The scoped `.shape` rule of Parent.ucf, which reaches a child root only through forwarding.
const PARENT_COLOR = 'rgb(200, 40, 80)';

// Every `data-case` of Parent.ucf whose child root is a JSX element, so it carries the parent's attribute.
const FORWARDED = [
  'MultiReturn:early',
  'MultiReturn:last',
  'Ternary:a',
  'Ternary:b',
  'NestedTernary:a',
  'NestedTernary:b',
  'NestedTernary:c',
  'AndRoot:or',
  'AndRoot:nullish',
  'AndRoot:and',
  'Memo:only',
  'ForwardRef:only',
  'MemoForwardRef:only',
  'ExportIdentifier:only',
  'ArrowExpression:only',
  'NoParams:only',
  'ConstRoot:only',
  'ComponentRoot:only',
];
// Fragment and non-JSX roots: no element of theirs gets it.
const NOT_FORWARDED = [
  'FragmentRoot:short',
  'FragmentRoot:named',
  'NullRoot:null',
  'NullRoot:string',
  'NullRoot:call',
  'NullRoot:children',
];

// Hand-counted from Stamped.ucf: every host element it renders, fragments rendering none.
const ELEMENT_COUNT = 19;

// Selector → the scoped rule's property and value in Stamped.ucf.
const SCOPED_RULES: [string, string, string][] = [
  ['.box', 'color', 'rgb(10, 20, 30)'],
  ['.dot', 'fill', 'rgb(40, 50, 60)'],
  ['my-el', 'color', 'rgb(70, 80, 90)'],
  ['.item', 'color', 'rgb(100, 110, 120)'],
  ['.member', 'color', 'rgb(130, 140, 150)'],
  ['.lookalike', 'color', 'rgb(160, 170, 180)'],
  ['.list', 'color', 'rgb(190, 200, 210)'],
];

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

function attributeOf(file: string, production: boolean): string {
  return `data-v-${scopeId(relative(ROOT, file).split(sep).join('/'), readFileSync(file, 'utf8'), production)}`;
}

async function scopeAttributes(page: Page) {
  const read = (locator: Locator) =>
    locator.evaluateAll((elements) =>
      elements.map((element) => ({
        tag: element.tagName,
        scope: element.getAttributeNames().filter((name: string) => name.startsWith('data-v-')),
      }))
    );
  return {app: (await read(page.locator('#app')))[0]!.scope, elements: await read(page.locator('#app *'))};
}

describe.each([
  ['dev', startDev, false],
  ['preview', buildAndPreview, true],
] as const)('react-scope in %s', (_mode, serve, production) => {
  const attribute = attributeOf(STAMPED, production);
  let app: {url: string; close(): Promise<void>} | undefined;

  beforeAll(async () => {
    app = await serve(ROOT);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("stamps every element of the block with the file's scope id, and the scoped rules apply", async () => {
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(app!.url);
      await page.locator('.box').waitFor();

      const {app: outside, elements} = await scopeAttributes(page);
      expect(outside).toEqual([]);
      expect(elements).toHaveLength(ELEMENT_COUNT);
      for (const element of elements) expect(element).toEqual({tag: element.tag, scope: [attribute]});

      for (const [selector, property, value] of SCOPED_RULES) {
        const found = await computed(page.locator(selector).first(), property);
        expect({selector, value: found}).toEqual({selector, value});
      }

      // A stamped Fragment would log React's "Invalid prop supplied to `React.Fragment`" in dev.
      await page.waitForLoadState('networkidle');
      expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("forwards the parent's scope attribute to every JSX root of a child, and the parent's scoped rule styles it", async () => {
    const parent = attributeOf(PARENT, production);
    const own = attributeOf(MULTI_RETURN, production);
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(`${app!.url}?page=shapes`);
      await page.locator('[data-case="ForwardRef:only"] [data-ref]').waitFor();

      expect(await page.locator('[data-case]').count()).toBe(FORWARDED.length + NOT_FORWARDED.length);
      for (const name of NOT_FORWARDED) {
        const carriers = await page.locator(`[data-case="${name}"] [${parent}]`).count();
        expect({name, carriers}).toEqual({name, carriers: 0});
      }
      for (const name of FORWARDED) {
        const wrapper = page.locator(`[data-case="${name}"]`);
        const carriers = await wrapper.locator(`[${parent}]`).count();
        const root = wrapper.locator(':scope > *');
        expect({name, roots: await root.count(), carriers}).toEqual({name, roots: 1, carriers: 1});
        expect({name, scope: await root.getAttribute(parent)}).toEqual({name, scope: ''});
        expect({name, color: await computed(root, 'color')}).toEqual({name, color: PARENT_COLOR});
        const inner = root.locator('.inner');
        expect({name, inner: await inner.getAttribute(parent)}).toEqual({name, inner: null});
        // MultiReturn has a scoped style of its own: its stamp sits beside the forwarded one.
        if (name.startsWith('MultiReturn:')) {
          expect(await root.getAttribute(own)).toBe('');
          expect(await inner.getAttribute(own)).toBe('');
        }
      }

      // The ref of the ForwardRef shape still reaches its root DOM node.
      expect(await page.locator('[data-case="ForwardRef:only"] > *').getAttribute('data-ref')).toBe('forward-ref');

      await page.waitForLoadState('networkidle');
      const reported = messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror');
      // Vue's multi-root rule: dev warns once for FragmentRoot, whatever its renders; a build never does.
      expect(reported.map(({type}) => type)).toEqual(production ? [] : ['warning']);
      if (!production) expect(reported[0]!.text).toContain('<FragmentRoot> renders a fragment root');
    } finally {
      await page.close();
    }
  });
});
