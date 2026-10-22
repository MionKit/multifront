// Milestone 5 exit test: Panel.front as Vue, React and Svelte in one real Vite app, in Chromium.
import {join, resolve} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, copyApp, removeApp} from '../fixtures/index.ts';
import {collectConsole, consoleProblems, computed, launchChromium} from './lib/chromium.ts';
import {styles} from './lib/parity.ts';
import {editFile, trackHmrPayloads, trackRequests} from './lib/requests.ts';
import {scopeAttribute} from './lib/scope.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'all-targets');
const FRAMEWORKS = ['vue', 'react', 'svelte'] as const;
// Panel's root, PanelItem's root, and Panel's heading.
const KEY_ELEMENTS = ['.panel', '.panel .item', '.panel .heading'];
const PROPERTIES = [
  'color',
  'font-size',
  'font-weight',
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-left',
  'border-left-width',
  'border-left-style',
  'border-left-color',
];
const POLL = {timeout: 10_000};

const scopesOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) =>
    element
      .getAttributeNames()
      .filter((name: string) => name.startsWith('data-v-'))
      .sort()
  );

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

describe.each([
  ['dev', startDev, false],
  ['build', buildAndPreview, true],
] as const)('milestone 5 exit test, all-targets %s', (_mode, serve, production) => {
  let app: Awaited<ReturnType<typeof serve>> | undefined;
  let page: Page | undefined;
  let messages: ReturnType<typeof collectConsole> = [];

  beforeAll(async () => {
    app = await serve(ROOT);
    page = await browser!.newPage();
    messages = collectConsole(page);
    await page.goto(app.url);
    for (const framework of FRAMEWORKS) await page.locator(`#${framework} .panel .item`).waitFor();
  });

  afterAll(async () => {
    await page?.close();
    await app?.close();
  });

  it('1. renders Panel.front as Vue, React and Svelte side by side, with the same data-v-* value', async () => {
    const panel = scopeAttribute(ROOT, componentPath('Panel.front'), production);
    for (const framework of FRAMEWORKS) {
      const heading = await page!.locator(`#${framework} .panel .heading`).textContent();
      expect({framework, heading}).toEqual({framework, heading: `${framework[0]!.toUpperCase()}${framework.slice(1)} panel`});
      for (const selector of ['.panel', '.panel .heading'])
        expect({framework, selector, scopes: await scopesOf(page!, `#${framework} ${selector}`)}).toEqual({
          framework,
          selector,
          scopes: [panel],
        });
    }
  });

  it('1. gives the key elements the same computed styles in all three', async () => {
    // Literal values: parity alone also passes when every target is unstyled.
    expect(await computed(page!.locator('#vue .panel'), 'padding-top')).toBe('16px');
    expect(await computed(page!.locator('#vue .panel .heading'), 'margin-bottom')).toBe('8px');
    expect(await computed(page!.locator('#vue .panel .heading'), 'color')).toBe('rgb(40, 90, 160)');
    for (const selector of KEY_ELEMENTS) {
      const vue = await styles(page!.locator(`#vue ${selector}`), PROPERTIES);
      for (const framework of FRAMEWORKS.slice(1)) {
        const other = await styles(page!.locator(`#${framework} ${selector}`), PROPERTIES);
        expect({framework, selector, styles: other}).toEqual({framework, selector, styles: vue});
      }
    }
  });

  it("3. Panel.front's scoped rule reaches PanelItem's root as Vue, React and Svelte, with equal computed styles", async () => {
    const panel = scopeAttribute(ROOT, componentPath('Panel.front'), production);
    const item = scopeAttribute(ROOT, componentPath('PanelItem.front'), production);
    for (const framework of FRAMEWORKS) {
      const root = page!.locator(`#${framework} .panel .item`);
      expect({framework, scopes: await scopesOf(page!, `#${framework} .panel .item`)}).toEqual({
        framework,
        scopes: [panel, item].sort(),
      });
      // Panel's `.item` rule: `padding-left: $pad * 0.5` and a 2px left border.
      expect({framework, padding: await computed(root, 'padding-left')}).toEqual({framework, padding: '8px'});
      expect({framework, border: await computed(root, 'border-left-color')}).toEqual({framework, border: 'rgb(40, 90, 160)'});
    }
  });

  it('logged no warning or error', async () => {
    await page!.waitForLoadState('networkidle');
    expect(consoleProblems(messages)).toEqual([]);
  });
});

describe('milestone 5 exit test, all-targets HMR', () => {
  it('2. a <svelte> edit hot-updates without a reload while the React counter keeps its state', async () => {
    const root = await copyApp('all-targets');
    const panelFile = resolve(root, '..', '..', 'components', 'Panel.front');
    let app: Awaited<ReturnType<typeof startDev>> | undefined;
    const page = await browser!.newPage();
    try {
      app = await startDev(root);
      const messages = collectConsole(page);
      const requests = trackRequests(page);
      const payloads = trackHmrPayloads(page);
      let loads = 0;
      page.on('load', () => void loads++);
      await page.goto(app.url);

      const count = () => page.locator('#react .counter button').textContent();
      await expect.poll(count, POLL).toBe('2');
      await page.locator('#react .counter button').click();
      await expect.poll(count).toBe('3');
      await requests.quiet(500);

      payloads.clear();
      await editFile(requests, panelFile, '{$style.title}">{heading}</h3>', '{$style.title}">{heading} edited</h3>');
      await expect.poll(() => page.locator('#svelte .panel .heading').textContent(), POLL).toBe('Svelte panel edited');
      await requests.quiet(500);

      expect(payloads.updatedPaths()).toEqual([`${panelFile}.svelte.svelte`]);
      expect(payloads.fullReloads()).toBe(0);
      expect(loads).toBe(1);
      expect(await count()).toBe('3');
      expect(await page.locator('#vue .panel .heading').textContent()).toBe('Vue panel');
      expect(await page.locator('#react .panel .heading').textContent()).toBe('React panel');
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await page.close();
      await app?.close();
      await removeApp(root);
    }
  });
});
