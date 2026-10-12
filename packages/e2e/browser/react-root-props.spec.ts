// Spec 3.5, item 5: a React root merges the parent's className, style and ref, in a real build and when hydrated.
import {join} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {collectConsole, computed, consoleProblems, launchChromium} from './lib/chromium.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const FIXTURE = join(FIXTURES_DIR, 'apps', 'react-root-props');
const RED = 'rgb(255, 0, 0)';
// In the page before any script: a client render instead of a hydration would remove the server's elements.
const WATCH_REMOVED = `window.removed = [];
new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.removedNodes)
      if (node instanceof Element && record.target.closest?.('#app')) window.removed.push(node.tagName);
}).observe(document, {childList: true, subtree: true});`;

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

async function classes(page: Page, selector: string): Promise<string[]> {
  return ((await page.locator(selector).getAttribute('class')) ?? '').split(' ');
}

// Waits for the effect that reads both refs, so the page has rendered on the client.
async function expectRootProps(page: Page): Promise<void> {
  await expect.poll(() => page.locator('output[data-ref="button"]').textContent()).toBe('BUTTON');
  expect(await page.locator('output[data-ref="own"]').textContent()).toBe('SECTION');

  // Button merges its CSS module class and its own style with the parent's.
  expect(await page.locator('[data-case="button"] > *').count()).toBe(1);
  const button = page.locator('[data-case="button"] > button');
  const [moduleClass, ...rest] = await classes(page, '[data-case="button"] > button');
  expect({moduleClass: moduleClass === 'extra', rest}).toEqual({moduleClass: false, rest: ['extra']});
  expect(await computed(button, 'padding')).toBe('4px 12px');
  expect(await computed(button, 'color')).toBe(RED);
  expect(await computed(button, 'font-weight')).toBe('600');

  // Badge reads className itself: the author wins, so `extra` shows once.
  expect(await classes(page, '[data-case="badge"] > span')).toEqual(['badge', 'extra']);

  // Own's own ref still gets the element, beside the parent's; the parent's padding wins over Own's.
  const own = page.locator('[data-case="own"] > section');
  expect(await classes(page, '[data-case="own"] > section')).toEqual(['own', 'extra']);
  expect(await computed(own, 'padding')).toBe('8px');
  expect(await computed(own, 'color')).toBe(RED);
  expect(await own.getAttribute('data-own-ref')).toBe('SECTION');
}

// The parent's callback ref: attached once over two renders (same merged ref), its own cleanup run on unmount.
async function expectRefCleanup(page: Page): Promise<void> {
  const counts = page.locator('output[data-ref="counts"]');
  await expect.poll(() => counts.getAttribute('data-counts')).toBe('1/0');
  await page.locator('[data-action="hide-own"]').click();
  await expect.poll(() => counts.getAttribute('data-counts')).toBe('1/1');
  expect(await page.locator('[data-case="own"] > *').count()).toBe(0);
}

describe('vite build and preview', () => {
  let preview: Awaited<ReturnType<typeof buildAndPreview>> | undefined;

  beforeAll(async () => {
    preview = await buildAndPreview(FIXTURE);
  });

  afterAll(async () => {
    await preview?.close();
  });

  it('merges className and style and sets both refs, with no console warning', async () => {
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(preview!.url);
      await expectRootProps(page);
      await expectRefCleanup(page);
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// React reports attribute mismatches only in development, so hydration is checked on the dev server.
describe('renderToString, hydrated', () => {
  let app: Awaited<ReturnType<typeof startDev>> | undefined;

  beforeAll(async () => {
    app = await startDev(FIXTURE);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('hydrates the server-rendered App without replacing a node, with the same props and no console warning', async () => {
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.addInitScript({content: WATCH_REMOVED});
      const response = await page.goto(`${app!.url}?ssr`);
      // Merged on the server already.
      expect(await response!.text()).toMatch(/<button [^>]*class="[^"]+ extra"[^>]*style="[^"]*color:red/);
      await expectRootProps(page);
      expect(await page.evaluate('window.removed')).toEqual([]);
      await expectRefCleanup(page);
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
