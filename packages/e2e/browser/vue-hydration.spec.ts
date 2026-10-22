import {writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {Browser} from 'playwright';
import {afterAll, beforeAll, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {startSsrServer} from '../build/lib/freshProcess.ts';
import {collectConsole, launchChromium} from './lib/chromium.ts';
import {scopeAttribute} from './lib/scope.ts';

let browser: Browser | undefined;
let root: string | undefined;
let server: ReturnType<typeof startSsrServer> | undefined;

beforeAll(async () => {
  browser = await launchChromium();
  root = await copyApp('vue');
  // Vite puts its dep cache beside the nearest package.json: this one is removed with the copy.
  await writeFile(join(root, 'package.json'), '{"type": "module"}\n');
  server = startSsrServer(root);
  await server.url;
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  if (root) await removeApp(root);
});

it('hydrates the server-rendered Counter.front, counts a click, and logs no warning', async () => {
  const page = await browser!.newPage();
  try {
    const messages = collectConsole(page);
    const response = await page.goto(await server!.url);
    const html = await response!.text();
    const scope = scopeAttribute(root!, resolve(root!, '..', '..', 'components', 'Counter.front'), false);
    // Server-rendered: the markup is in the page before any script runs.
    expect(html).toContain(`<div class="counter" ${scope}>`);
    expect(html).toMatch(/<button [^>]*>2<\/button>/);

    // Vue sets it on the container when the mount is done, in every build.
    await expect.poll(() => page.locator('#app').evaluate((element) => '__vue_app__' in element)).toBe(true);
    // `createApp()` would mount over the markup and set it; `createSSRApp()` hydrates and does not.
    expect(await page.locator('#app').getAttribute('data-v-app')).toBeNull();
    const button = page.locator('.counter button');
    await button.click();
    await expect.poll(() => button.textContent()).toBe('3');
    // A mismatch is a `[Vue warn]` warning plus a console error.
    expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
  } finally {
    await page.close();
  }
});
