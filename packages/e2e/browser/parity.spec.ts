// The demo renders Counter.front as React and as Vue on one page: same scope id, same styles, separate state.
import {join} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {expectSameComputedStyles} from './lib/parity.ts';
import {scopeAttribute} from './lib/scope.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'demo');
const COUNTERS = {react: '#app [data-demo="counter"] > .counter', vue: '#vue > .counter'};
const PROPERTIES = ['padding', 'color', 'font-size', 'border'];
// Counter's root, its title and its button.
const PARTS = ['', ' .label', ' button'];

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

describe.each([
  ['dev', startDev, false],
  ['preview', buildAndPreview, true],
] as const)('Counter.front as React and as Vue in the demo (%s)', (_mode, serve, production) => {
  let app: Awaited<ReturnType<typeof serve>> | undefined;
  let page: Page;
  let messages: ReturnType<typeof collectConsole>;

  beforeAll(async () => {
    app = await serve(ROOT);
    page = await browser!.newPage();
    messages = collectConsole(page);
    await page.goto(app.url);
    await page.locator(`${COUNTERS.react} button`).waitFor();
    await page.locator(`${COUNTERS.vue} button`).waitFor();
  });

  afterAll(async () => {
    await page?.close();
    await app?.close();
  });

  it('gives both roots the same data-v-*', async () => {
    const scope = scopeAttribute(ROOT, componentPath('Counter.front'), production);
    expect(await page.locator(COUNTERS.react).getAttribute(scope)).toBe('');
    expect(await page.locator(COUNTERS.vue).getAttribute(scope)).toBe('');
  });

  it('computes the same styles on the root, the title and the button', async () => {
    // Hand-read from Counter.front: two unstyled elements would match each other too.
    expect(await computed(page.locator(COUNTERS.vue), 'color')).toBe('rgb(120, 40, 160)');
    expect(await computed(page.locator(`${COUNTERS.vue} button`), 'padding')).toBe('4px 12px');
    for (const part of PARTS) {
      await expectSameComputedStyles(page.locator(COUNTERS.react + part), page.locator(COUNTERS.vue + part), PROPERTIES);
    }
  });

  it('counts the clicks of each counter on its own', async () => {
    const react = page.locator(`${COUNTERS.react} button`);
    const vue = page.locator(`${COUNTERS.vue} button`);
    expect([await react.textContent(), await vue.textContent()]).toEqual(['0', '0']);
    await react.click();
    await expect.poll(() => react.textContent()).toBe('1');
    expect(await vue.textContent()).toBe('0');
    await vue.click();
    await vue.click();
    await expect.poll(() => vue.textContent()).toBe('2');
    expect(await react.textContent()).toBe('1');
  });

  it('logs no warning or error', async () => {
    await page.waitForLoadState('networkidle');
    expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
  });
});
