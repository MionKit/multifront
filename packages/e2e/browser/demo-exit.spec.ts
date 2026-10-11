// Milestone 3's exit test: the demo app through real Vite, real plugin-react and Chromium, in dev, build and SSR.
import {readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {Browser, Page} from 'playwright';
import {isRunnableDevEnvironment} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {expectNoAttribute} from '../build/lib/references.ts';
import {collectConsole, computed, launchChromium, renderedStyles} from './lib/chromium.ts';
import {editFile, trackRequests} from './lib/requests.ts';
import {scopeAttribute} from './lib/scope.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const FIXTURE = join(FIXTURES_DIR, 'apps', 'demo');
const COUNTER = '[data-demo="counter"]';
const BADGE = '[data-demo="panel"] .panel > span';
const BADGE_LABEL = '[data-demo="panel"] .badge-label';
const CARD_TITLES = ['Bare import', 'From the .ts helper'];
// Every styled demo component, relative to the shared `components/`.
const STYLED = ['Counter.ucf', 'react/ScopedPanel.ucf', 'Card.ucf'];
const POLL = {timeout: 10_000};

let browser: Browser | undefined;
let root: string | undefined;
let app: Awaited<ReturnType<typeof startDev>> | undefined;
let page: Page;
let messages: ReturnType<typeof collectConsole>;
let requests: ReturnType<typeof trackRequests>;
let loads = 0;
let devStyles: Awaited<ReturnType<typeof renderedStyles>> | undefined;

const component = (name: string) => resolve(root!, '..', '..', 'components', name);

const edit = (from: string, to: string) => editFile(requests, component('Counter.ucf'), from, to);

beforeAll(async () => {
  browser = await launchChromium();
  root = await copyApp('demo');
  app = await startDev(root);
  page = await browser.newPage();
  messages = collectConsole(page);
  page.on('load', () => void loads++);
  requests = trackRequests(page);
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await app?.close();
  if (root) await removeApp(root);
});

describe('milestone 3 exit test (demo app)', () => {
  it('renders Counter, ScopedPanel with ScopedBadge, and Card, and their $style classes apply', async () => {
    await page.goto(app!.url);
    await page.locator(`${COUNTER} button`).waitFor();

    expect(await page.locator(`${COUNTER} button`).textContent()).toBe('0');
    expect(await page.locator(BADGE_LABEL).textContent()).toBe('new');
    expect(await page.locator('[data-demo="card"] h2').allTextContents()).toEqual(CARD_TITLES);
    expect(await computed(page.locator(`${COUNTER} button`), 'padding')).toBe('4px 12px');
    expect(await computed(page.locator(`${COUNTER} .counter`), 'color')).toBe('rgb(120, 40, 160)');
    for (const title of CARD_TITLES) {
      const card = page.locator(`[data-demo="card"] div:has(> h2:text-is("${title}"))`);
      expect({title, padding: await computed(card, 'padding')}).toEqual({title, padding: '16px'});
    }
    devStyles = await renderedStyles(page);
    await requests.quiet(500);
  });

  it("ScopedPanel's scoped style reaches ScopedBadge's root span, and not its inner element", async () => {
    const panel = scopeAttribute(root!, component('react/ScopedPanel.ucf'), false);
    expect(await page.locator(BADGE).getAttribute(panel)).toBe('');
    expect(await computed(page.locator(BADGE), 'color')).toBe('rgb(30, 120, 60)');
    expect(await page.locator(BADGE_LABEL).getAttribute(panel)).toBeNull();
    expect(await computed(page.locator(BADGE_LABEL), 'text-decoration-line')).toBe('none');
  });

  it('keeps the count of 3 over three <react> edits, each shown without a page load', async () => {
    const button = page.locator(`${COUNTER} button`);
    for (let click = 0; click < 3; click++) await button.click();
    await expect.poll(() => button.textContent()).toBe('3');
    await requests.quiet(500);

    for (const [from, to] of [
      ['Clicks', 'Taps'],
      ['Taps', 'Hits'],
      ['Hits', 'Presses'],
    ]) {
      await edit(`<span className="label">${from}</span>`, `<span className="label">${to}</span>`);
      await expect.poll(() => page.locator(`${COUNTER} .label`).textContent(), POLL).toBe(to);
      // Also spaces the next write past the watcher's 50 ms per-file change throttle.
      await requests.quiet(500);
      expect({to, count: await button.textContent(), loads}).toEqual({to, count: '3', loads: 1});
    }
  });

  it('a <style scoped> edit shows, keeps the count and requests no .ucf.react.tsx module', async () => {
    await edit('rgb(120, 40, 160)', 'rgb(10, 20, 30)');
    await expect.poll(() => computed(page.locator(`${COUNTER} .counter`), 'color'), POLL).toBe('rgb(10, 20, 30)');
    await requests.quiet(500);

    expect(await page.locator(`${COUNTER} button`).textContent()).toBe('3');
    expect(requests.paths()).toContain(`/@fs${component('Counter.ucf')}?ucf&type=style&index=0&lang.css`);
    expect(requests.paths().filter((path) => path.endsWith('.ucf.react.tsx'))).toEqual([]);
  });

  it('loaded the page once and logged no warning or error', () => {
    expect(loads).toBe(1);
    expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
  });

  it("renders through the SSR module runner with ScopedPanel's scope on ScopedBadge's root span", async () => {
    const ssr = app!.server.environments.ssr;
    if (!isRunnableDevEnvironment(ssr)) throw new Error('the ssr environment has no module runner');
    const {render} = (await ssr.runner.import('/src/entry-server.tsx')) as {render: () => string};
    const html = render();
    const panel = scopeAttribute(root!, component('react/ScopedPanel.ucf'), false);
    const rendered = await browser!.newPage();
    try {
      await rendered.setContent(html);
      expect(await rendered.locator('[data-demo="card"] h2').allTextContents()).toEqual(CARD_TITLES);
      expect(await rendered.locator(BADGE).getAttribute(panel)).toBe('');
      expect(await rendered.locator(BADGE_LABEL).getAttribute(panel)).toBeNull();
    } finally {
      await rendered.close();
    }
  });

  describe('vite build and preview', () => {
    let preview: Awaited<ReturnType<typeof buildAndPreview>> | undefined;
    let files: string[] = [];

    // Pristine fixture, not the edited copy: same relative paths, so same scope ids.
    beforeAll(async () => {
      preview = await buildAndPreview(FIXTURE);
      files = readdirSync(preview.outDir, {recursive: true, withFileTypes: true})
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
    });

    afterAll(async () => {
      await preview?.close();
    });

    it('computes the same styles as dev did before the edits', async () => {
      const previewPage = await browser!.newPage();
      try {
        await previewPage.goto(preview!.url);
        await previewPage.locator(`${COUNTER} button`).waitFor();
        expect(devStyles).toBeDefined();
        expect(await renderedStyles(previewPage)).toEqual(devStyles);
      } finally {
        await previewPage.close();
      }
    });

    it('leaves no with or framework in any output file', () => {
      expect(files.some((file) => file.endsWith('.js'))).toBe(true);
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        // React's code contains "object with keys {": `with` is checked on parsed imports only.
        expect({file, framework: text.includes('framework')}).toEqual({file, framework: false});
        if (file.endsWith('.js')) expectNoAttribute(text);
      }
    });

    it("puts each style block's CSS in the output once", async () => {
      const css = files
        .filter((file) => file.endsWith('.css'))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      let blocks = 0;
      let selectors = 0;
      for (const name of STYLED) {
        const {filename, source} = readComponent(name);
        const split = splitBlocks(source, filename);
        const ctx = await createBuildContext(split, {root: FIXTURE, compiler: loadVueCompiler(FIXTURE), production: true});
        for (const style of ctx.styles) {
          blocks++;
          for (const [, rule] of style.code.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
            const selector = rule!.trim();
            expect({name, selector, count: css.split(selector).length - 1}).toEqual({name, selector, count: 1});
            selectors++;
          }
        }
      }
      expect({blocks, selectors}).toEqual({blocks: 4, selectors: 6});
    });
  });
});
