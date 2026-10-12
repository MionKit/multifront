// Milestone 5.8: a parent's scoped style reaches a Svelte child's root, as in Vue and React.
import {join} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {expectSameComputedStyles} from './lib/parity.ts';
import {scopeAttribute} from './lib/scope.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'all-targets');
const ROOTS_PARENT = join(ROOT, 'Roots.ucf');
const POLL = {timeout: 10_000};

// PanelItem's root in each framework's Panel.
const ITEMS = ['#vue .item', '#react .item', '#svelte .item'];
// Panel.ucf's scoped `.item` rule: padding-left is `$pad * 0.5`.
const PANEL_RULE: [string, string][] = [
  ['padding-left', '8px'],
  ['border-left-width', '2px'],
  ['border-left-style', 'solid'],
  ['border-left-color', 'rgb(40, 90, 160)'],
];
// PanelItem.ucf's own scoped `.item` rule.
const ITEM_RULE: [string, string][] = [
  ['color', 'rgb(60, 60, 60)'],
  ['margin-top', '0px'],
];

// Roots.ucf's scoped `.shape` rule, which reaches a child root only through forwarding.
const PARENT_COLOR = 'rgb(200, 40, 80)';
const FORWARDED = [
  'IfElseRoot:a',
  'IfElseRoot:b',
  'IfElseRoot:c',
  'ComponentRoot:only',
  'SvelteElementRoot:only',
  'NestedRoot:then',
  'RestRoot:only',
  'NoPropsRoot:only',
];
// Each warns once in dev, with its own problem.
const WARNED: [string, string][] = [
  ['EachRoot', 'renders an {#each} block as its root'],
  ['MultiRoot', 'renders more than one root'],
  ['LegacyRoot', 'is a legacy-mode Svelte component'],
];

const problems = (messages: ReturnType<typeof collectConsole>) =>
  messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror');

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

async function withPage(url: string, run: (page: Page, messages: ReturnType<typeof collectConsole>) => Promise<void>) {
  const page = await browser!.newPage();
  try {
    const messages = collectConsole(page);
    await page.goto(url);
    await run(page, messages);
  } finally {
    await page.close();
  }
}

describe.each([
  ['dev', startDev, false],
  ['preview', buildAndPreview, true],
] as const)('svelte scope forwarding in all-targets, %s', (_mode, serve, production) => {
  let app: {url: string; close(): Promise<void>} | undefined;

  beforeAll(async () => {
    app = await serve(ROOT);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("puts Panel's scope on PanelItem's root in Vue, React and Svelte, with the same computed style", async () => {
    const panel = scopeAttribute(ROOT, componentPath('Panel.ucf'), production);
    const item = scopeAttribute(ROOT, componentPath('PanelItem.ucf'), production);
    await withPage(app!.url, async (page, messages) => {
      for (const selector of ITEMS) await page.locator(selector).waitFor();
      for (const selector of ITEMS) {
        const root = page.locator(selector);
        expect({selector, text: await root.textContent()}).toEqual({selector, text: 'first item'});
        for (const scope of [panel, item])
          expect({selector, scope, value: await root.getAttribute(scope)}).toEqual({selector, scope, value: ''});
        for (const [property, value] of [...PANEL_RULE, ...ITEM_RULE])
          expect({selector, property, value: await computed(root, property)}).toEqual({selector, property, value});
      }
      const properties = [...PANEL_RULE, ...ITEM_RULE].map(([property]) => property);
      const [vue, ...others] = ITEMS.map((selector) => page.locator(selector));
      for (const other of others) await expectSameComputedStyles(vue!, other, properties);

      await page.waitForLoadState('networkidle');
      expect(problems(messages)).toEqual([]);
    });
  });

  it('forwards to every single-root shape of svelte/roots/, and to none of the others', async () => {
    const parent = scopeAttribute(ROOT, ROOTS_PARENT, production);
    await withPage(`${app!.url}?page=roots`, async (page, messages) => {
      // The promise resolved: NestedRoot shows its `{:then}` branch.
      await expect.poll(() => page.locator('[data-case="NestedRoot:then"] .inner').textContent(), POLL).toBe('resolved');
      expect(await page.locator('[data-case]').count()).toBe(FORWARDED.length + WARNED.length);
      for (const name of FORWARDED) {
        const wrapper = page.locator(`[data-case="${name}"]`);
        const root = wrapper.locator(':scope > *');
        expect({name, roots: await root.count(), carriers: await wrapper.locator(`[${parent}]`).count()}).toEqual({
          name,
          roots: 1,
          carriers: 1,
        });
        expect({name, scope: await root.getAttribute(parent)}).toEqual({name, scope: ''});
        expect({name, color: await computed(root, 'color')}).toEqual({name, color: PARENT_COLOR});
        expect({name, inner: await root.locator('.inner').getAttribute(parent)}).toEqual({name, inner: null});
      }
      // ComponentRoot passes the scope on to SvelteElementRoot's `<article>`.
      expect(await page.locator('[data-case="ComponentRoot:only"] > article').count()).toBe(1);
      for (const [name] of WARNED) {
        const carriers = await page.locator(`[data-case="${name}:only"] [${parent}]`).count();
        expect({name, carriers}).toEqual({name, carriers: 0});
      }

      await page.waitForLoadState('networkidle');
      const reported = problems(messages);
      // Dev warns once per component, however often it renders; a build never does.
      expect(reported.map(({type}) => type)).toEqual(production ? [] : WARNED.map(() => 'warning'));
      if (production) return;
      for (const [name, problem] of WARNED)
        expect(
          reported.filter(({text}) => text.startsWith(`[multifront] <${name}> ${problem}, so no element receives ${parent}`))
        ).toHaveLength(1);
    });
  });
});
