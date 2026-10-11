import {setTimeout as sleep} from 'node:timers/promises';
import {join} from 'node:path';
import type {Browser, Page} from 'playwright';
import {createLogger, type ViteDevServer} from 'vite';
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

// Compared between dev and preview for every element of the app.
const PARITY_PROPERTIES = ['color', 'padding', 'text-decoration-line', 'font-size'];

type ElementStyles = {tag: string; text: string | null; styles: string[]};

let browser: Browser | undefined;
const rendered: Partial<Record<'dev' | 'preview', ElementStyles[]>> = {};

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

function elementStyles(page: Page): Promise<ElementStyles[]> {
  return page.locator('#app *').evaluateAll(
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
}

describe.each([
  ['dev', startDev],
  ['preview', buildAndPreview],
] as const)('demo in %s', (mode, serve) => {
  let app: {url: string; close(): Promise<void>} | undefined;

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

      rendered[mode] = await elementStyles(page);
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

/** Until the optimizer committed its run and had time to log a rerun (Vite logs one 200 ms after it commits). */
async function optimizerSettled(server: ViteDevServer) {
  const client = server.environments.client;
  await client.waitForRequestsIdle();
  const optimizer = client.depsOptimizer!;
  await optimizer.scanProcessing;
  for (let tries = 0; Object.keys(optimizer.metadata.discovered).length > 0; tries++) {
    if (tries === 200) throw new Error(`deps still pending: ${Object.keys(optimizer.metadata.discovered).join(', ')}`);
    await sleep(50);
  }
  await sleep(500);
}

describe('demo dev cold start', () => {
  it('pre-bundles every dependency at startup: no "dependencies optimized" and no reload after the first load', async () => {
    const logs: {level: string; message: string}[] = [];
    const logger = createLogger('silent');
    logger.info = (message) => void logs.push({level: 'info', message});
    logger.warn = (message) => void logs.push({level: 'warn', message});
    logger.warnOnce = logger.warn;
    logger.error = (message) => void logs.push({level: 'error', message});
    // Each server gets its own fresh cache dir: an empty `node_modules/.vite`.
    const app = await startDev(ROOT, {logger});
    const page = await browser!.newPage();
    try {
      let loads = 0;
      page.on('load', () => void loads++);
      await page.goto(app.url);
      await page.locator('[data-demo="counter"] button').waitFor();
      await page.waitForLoadState('networkidle');
      await optimizerSettled(app.server);
      await page.waitForLoadState('networkidle');

      expect(logs.filter(({level, message}) => level !== 'info' || /optimiz|reload/i.test(message))).toEqual([]);
      expect(loads).toBe(1);
    } finally {
      await page.close();
      await app.close();
    }
  });
});
