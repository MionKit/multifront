import {resolve} from 'node:path';
import type {Browser} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, hasClass, removeApp} from '../fixtures/index.ts';
import {startNodeServer, startViteCli, startViteDev} from '../build/lib/freshProcess.ts';
import {collectConsole, launchChromium} from './lib/chromium.ts';
import {scopeAttribute} from './lib/scope.ts';

// Saves the server-rendered `section.panel`: hydration keeps that node, a re-mount replaces it.
const KEEP_SERVER_PANEL = `new MutationObserver(() => {
  globalThis.ssrPanel ??= document.querySelector('section.panel');
}).observe(document, {childList: true, subtree: true});`;

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

// SvelteKit's dev server inlines the page's CSS; a build links its chunks' files.
async function pageCss(url: string, html: string, production: boolean): Promise<string> {
  if (!production) return /<style data-sveltekit>([^]*?)<\/style>/.exec(html)?.[1] ?? '';
  const hrefs = [...html.matchAll(/<link href="([^"]+\.css)" rel="stylesheet">/g)].map((match) => match[1]!);
  expect(hrefs, 'the CSS links').not.toEqual([]);
  const files = await Promise.all(
    hrefs.map(async (href) => {
      const response = await fetch(new URL(href, url));
      expect(response.status).toBe(200);
      return response.text();
    })
  );
  return files.join('\n');
}

async function checkPage(root: string, url: string, production: boolean) {
  const page = await browser!.newPage();
  try {
    const messages = collectConsole(page);
    let loads = 0;
    page.on('load', () => void loads++);
    await page.addInitScript({content: KEEP_SERVER_PANEL});
    const response = await page.goto(url);
    const html = await response!.text();
    const scopeOf = (name: string) => scopeAttribute(root, resolve(root, '..', '..', 'components', name), production);
    const [panel, item, counter] = [scopeOf('Panel.ucf'), scopeOf('PanelItem.ucf'), scopeOf('Counter.ucf')];
    expect(html).toContain(`<section ${panel}="" class="panel"`);
    expect(html).toContain(`<p ${item}="" class="item"`);
    expect(html).toContain(`<div ${counter}="" class="counter">`);
    expect(html).toMatch(/<button [^>]*>2<\/button>/);
    const css = await pageCss(url, html, production);
    for (const [selector, scope] of [
      ['.panel', panel],
      ['.item', item],
      ['.counter', counter],
    ]) {
      expect(css).toContain(`${selector}[${scope}]`);
    }
    const buttonClass = new RegExp(`<button ${counter}="" class="([^"]+)"`).exec(html)?.[1];
    expect(buttonClass).toBeDefined();
    expect(hasClass(css, buttonClass!)).toBe(true);

    // The route's `onMount` sets it.
    await page.locator('body[data-hydrated]').waitFor();
    expect(
      await page.locator('section.panel').evaluate((element) => element === (globalThis as {ssrPanel?: unknown}).ssrPanel)
    ).toBe(true);
    const button = page.locator('.counter button');
    await button.click();
    await expect.poll(() => button.textContent()).toBe('3');

    // Hydration keeps the server's attributes: only an element the client renders shows the client's id.
    await page.locator('a[href="/items"]').click();
    const clientItem = page.locator('p.item', {hasText: 'client item'});
    await clientItem.waitFor();
    expect(await clientItem.getAttribute(item)).toBe('');
    expect(loads).toBe(1);
    // Svelte's dev `hydration_mismatch` is a warning.
    expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
  } finally {
    await page.close();
  }
}

describe('SvelteKit dev server', () => {
  let root: string | undefined;
  let server: ReturnType<typeof startViteDev> | undefined;

  beforeAll(async () => {
    root = await copyApp('sveltekit-src');
  });

  afterAll(async () => {
    await server?.stop();
    if (root) await removeApp(root);
  });

  it('renders .ucf sources on the server and hydrates them', async () => {
    server = startViteDev(root!);
    await checkPage(root!, await server.url, false);
    expect(server.output()).not.toMatch(/error/i);
  });

  it('renders and hydrates again from a new dev server process (cache miss)', async () => {
    await server?.stop();
    server = startViteDev(root!);
    await checkPage(root!, await server.url, false);
    expect(server.output()).not.toMatch(/error/i);
  });
});

describe('SvelteKit build with adapter-node', () => {
  let root: string | undefined;
  let build: ReturnType<typeof startViteCli> | undefined;
  let server: ReturnType<typeof startNodeServer> | undefined;

  beforeAll(async () => {
    root = await copyApp('sveltekit-src');
    build = startViteCli(root, ['build'], {NODE_ENV: 'production'});
    await build.finished();
    server = startNodeServer(root);
    await server.url;
  });

  afterAll(async () => {
    // A build past the hook timeout is still writing into the copy.
    await build?.stop();
    await server?.stop();
    if (root) await removeApp(root);
  });

  it('renders .ucf sources on the server and hydrates them', async () => {
    await checkPage(root!, await server!.url, true);
  });
});
