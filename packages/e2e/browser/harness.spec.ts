import {afterEach, describe, expect, it} from 'vitest';
import {collectConsole, launchChromium} from './lib/chromium.ts';

const CHROMIUM_PATH = process.env.MULTIFRONT_CHROMIUM_PATH;

afterEach(() => {
  if (CHROMIUM_PATH === undefined) delete process.env.MULTIFRONT_CHROMIUM_PATH;
  else process.env.MULTIFRONT_CHROMIUM_PATH = CHROMIUM_PATH;
});

describe('browser harness', () => {
  it('collects console messages and uncaught page errors', async () => {
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      const messages = collectConsole(page);
      await page.setContent('<script>console.warn("harness-warn"); console.error("harness-error");</script>');
      await page.setContent('<script>throw new Error("harness-throw")</script>');
      await expect.poll(() => messages.length).toBe(3);
      expect(messages).toEqual([
        {type: 'warning', text: 'harness-warn'},
        {type: 'error', text: 'harness-error'},
        {type: 'pageerror', text: 'harness-throw'},
      ]);
    } finally {
      await browser.close();
    }
  });

  it('names the fix when Chromium does not start', async () => {
    process.env.MULTIFRONT_CHROMIUM_PATH = '/nonexistent/multifront-chromium';
    await expect(launchChromium()).rejects.toThrow(
      'Chromium did not start: run `pnpm exec playwright install chromium` or set MULTIFRONT_CHROMIUM_PATH (see .env.sample).'
    );
  });
});
