import {join} from 'node:path';
import type {Browser, Locator} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {collectConsole, launchChromium} from './lib/chromium.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'react-basic');

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
}

describe.each([
  ['dev', startDev],
  ['preview', buildAndPreview],
])('react-basic in %s', (_mode, serve) => {
  let app: {url: string; close(): Promise<void>} | undefined;

  beforeAll(async () => {
    app = await serve(ROOT);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('renders AllBlocks with its module, named module and global styles, and no console error', async () => {
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(app!.url);
      const marker = page.getByText('all-blocks-react-marker', {exact: true});
      await marker.waitFor();

      // `$style.card` is on the marker's parent, `classes.title` on the "All blocks" line.
      expect(await computed(marker.locator('..'), 'padding')).toBe('16px');
      expect(await computed(page.getByText('All blocks', {exact: true}), 'color')).toBe('rgb(20, 90, 160)');
      expect(await computed(marker, 'font-style')).toBe('italic');
      expect(await marker.getAttribute('class')).toBe('all-blocks-global');

      await page.waitForLoadState('networkidle');
      expect(messages.filter((entry) => entry.type === 'error' || entry.type === 'pageerror')).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
