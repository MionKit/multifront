import {setTimeout as sleep} from 'node:timers/promises';
import {join} from 'node:path';
import type {Browser} from 'playwright';
import {createLogger} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'demo');

// [what, selector, property, value], hand-read from Counter.ucf, ScopedPanel.ucf and Card.ucf.
const STYLES: [string, string, string, string][] = [
  ['Counter scoped .counter', '[data-demo="counter"] .counter', 'color', 'rgb(120, 40, 160)'],
  ['Counter $style.button', '[data-demo="counter"] button', 'padding', '4px 12px'],
  ['ScopedPanel scoped .panel', '[data-demo="panel"] .panel', 'padding', '8px'],
  ["ScopedPanel's .badge on ScopedBadge's root", '[data-demo="panel"] .badge', 'color', 'rgb(30, 120, 60)'],
  [
    "ScopedPanel's .badge-label misses ScopedBadge's inner element",
    '[data-demo="panel"] .badge-label',
    'text-decoration-line',
    'none',
  ],
  ['bare Card $style.card', '[data-demo="card"] div:has(> h2:text-is("Bare import"))', 'padding', '16px'],
  ['helper Card $style.card', '[data-demo="card"] div:has(> h2:text-is("From the .ts helper"))', 'padding', '16px'],
];

const LOG_LEVELS = ['info', 'warn', 'warnOnce', 'error'] as const;

// Compared between dev and preview for every element of the app.
const PARITY_PROPERTIES = ['color', 'padding', 'text-decoration-line', 'font-size'];

let browser: Browser | undefined;
const rendered: Partial<Record<'dev' | 'preview', unknown>> = {};

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

describe.each([
  ['dev', startDev],
  ['preview', buildAndPreview],
] as const)('demo in %s', (mode, serve) => {
  let app: Awaited<ReturnType<typeof serve>> | undefined;

  beforeAll(async () => {
    app = await serve(ROOT);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('renders Counter, ScopedPanel with ScopedBadge and both Cards, with their styles and no console error', async () => {
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(app!.url);
      await page.locator('[data-demo="counter"] button').waitFor();

      expect(await page.locator('[data-demo="counter"] button').textContent()).toBe('0');
      expect(await page.locator('[data-demo="panel"] .badge-label').textContent()).toBe('new');
      expect(await page.locator('[data-demo="card"] h2').allTextContents()).toEqual(['Bare import', 'From the .ts helper']);
      for (const [what, selector, property, value] of STYLES) {
        const found = await computed(page.locator(selector), property);
        expect({what, value: found}).toEqual({what, value});
      }

      rendered[mode] = await page.locator('#app *').evaluateAll(
        (elements, properties) =>
          elements.map((element) => {
            const style = element.ownerDocument.defaultView!.getComputedStyle(element);
            return {
              tag: element.tagName,
              text: element.children.length === 0 ? element.textContent : null,
              styles: properties.map((name) => style.getPropertyValue(name)),
            };
          }),
        PARITY_PROPERTIES
      );
      await page.waitForLoadState('networkidle');
      expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describe('demo in dev and preview', () => {
  it('computes the same styles for every element', () => {
    expect(rendered.dev).toBeDefined();
    expect(rendered.dev).toEqual(rendered.preview);
  });
});

describe('demo dev cold start', () => {
  it('pre-bundles every dependency at startup: no "dependencies optimized" and no reload after the first load', async () => {
    const logs: {level: (typeof LOG_LEVELS)[number]; message: string}[] = [];
    const logger = createLogger('silent');
    for (const level of LOG_LEVELS) logger[level] = (message) => void logs.push({level, message});
    // Each server gets its own fresh cache dir: an empty `node_modules/.vite`.
    const app = await startDev(ROOT, logger);
    try {
      // A healthy cold start logs nothing: without this, an unwired logger would pass too.
      expect(app.server.config.logger).toBe(logger);
      const page = await browser!.newPage();
      try {
        let loads = 0;
        page.on('load', () => void loads++);
        await page.goto(app.url);
        await page.locator('[data-demo="counter"] button').waitFor();
        await page.waitForLoadState('networkidle');
        const client = app.server.environments.client;
        await client.waitForRequestsIdle();
        const optimizer = client.depsOptimizer!;
        await optimizer.scanProcessing;
        // Committing a run empties `discovered`; Vite logs a rerun's "dependencies optimized" 200 ms later.
        await expect.poll(() => Object.keys(optimizer.metadata.discovered), {timeout: 10_000}).toEqual([]);
        await sleep(500);
        await page.waitForLoadState('networkidle');

        expect(logs.filter(({level, message}) => level !== 'info' || /optimiz|reload/i.test(message))).toEqual([]);
        expect(loads).toBe(1);
      } finally {
        await page.close();
      }
    } finally {
      await app.close();
    }
  });
});
