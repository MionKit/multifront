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
const SCOPED_PANEL = componentPath('react/ScopedPanel.ucf');

// The scoped `.shape` rule of Parent.ucf, which reaches a child root only through forwarding.
const PARENT_COLOR = 'rgb(200, 40, 80)';

// `data-case`s of Parent.ucf whose child root is a JSX element.
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
  'Destructured:only',
  'DestructuredArrow:only',
  'DestructuredDefaults:defaults',
  'DestructuredDefaults:given',
  'ForwardRefDestructured:only',
];
// Destructuring defaults and rest props, as DestructuredDefaults.ucf renders them.
const DEFAULTS_TEXT: [string, string][] = [
  ['DestructuredDefaults:defaults', 'default label / defaults / no note'],
  ['DestructuredDefaults:given', 'given label / given / rest note'],
];

// ScopedPanel.ucf's scoped rules: `.badge` reaches ScopedBadge's root, `.badge-label` must not reach its inner element.
const BADGE_COLOR = 'rgb(30, 120, 60)';
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
      await page.locator('[data-case="ForwardRefDestructured:only"] [data-ref]').waitFor();

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
        // MultiReturn has its own scoped style, so its stamp sits beside the forwarded one.
        if (name.startsWith('MultiReturn:')) {
          expect(await root.getAttribute(own)).toBe('');
          expect(await inner.getAttribute(own)).toBe('');
        }
      }

      // Forwarding must not break the ref.
      for (const name of ['ForwardRef:only', 'ForwardRefDestructured:only']) {
        const ref = await page.locator(`[data-case="${name}"] > *`).getAttribute('data-ref');
        expect({name, ref}).toEqual({name, ref: 'forward-ref'});
      }
      for (const [name, text] of DEFAULTS_TEXT)
        expect({name, text: await page.locator(`[data-case="${name}"] .inner`).textContent()}).toEqual({name, text});

      await page.waitForLoadState('networkidle');
      const reported = messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror');
      // Dev warns once for FragmentRoot, however often it renders; a build never does.
      expect(reported.map(({type}) => type)).toEqual(production ? [] : ['warning']);
      if (!production) expect(reported[0]!.text).toContain('<FragmentRoot> renders a fragment root');
    } finally {
      await page.close();
    }
  });
  it("forwards ScopedPanel's scope to the root span of the destructuring ScopedBadge, and not to its inner element", async () => {
    const panel = attributeOf(SCOPED_PANEL, production);
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(`${app!.url}?page=panel`);
      const badge = page.locator('.panel > span');
      await badge.waitFor();

      expect(await badge.getAttribute(panel)).toBe('');
      expect(await badge.getAttribute('class')).toBe('badge');
      expect(await computed(badge, 'color')).toBe(BADGE_COLOR);
      const label = badge.locator('em.badge-label');
      expect(await label.textContent()).toBe('new');
      expect(await label.getAttribute(panel)).toBeNull();
      expect(await computed(label, 'text-decoration-line')).toBe('none');

      await page.waitForLoadState('networkidle');
      expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
