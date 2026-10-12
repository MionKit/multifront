import {join, resolve} from 'node:path';
import type {Browser, Page} from 'playwright';
import {createLogger} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {editFile, trackHmrPayloads, trackRequests} from './lib/requests.ts';
import {startDev} from './lib/serve.ts';

const SVELTE_PANEL = '[data-marker="panel-svelte-marker"]';
const POLL = {timeout: 10_000};

type Opened = Awaited<ReturnType<typeof openApp>>;

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

async function openApp(name: string) {
  const root = await copyApp(name);
  const logs: string[] = [];
  const logger = createLogger('silent');
  for (const level of ['warn', 'warnOnce', 'error'] as const) logger[level] = (message) => void logs.push(`${level}: ${message}`);
  let app: Awaited<ReturnType<typeof startDev>> | undefined;
  let page: Page | undefined;
  const close = async () => {
    await page?.close();
    await app?.close();
    await removeApp(root);
  };
  try {
    app = await startDev(root, logger);
    // A logger left unwired would pass every log check.
    expect(app.server.config.logger).toBe(logger);
    page = await browser!.newPage();
    // The copy's apps import `../../../components/…`.
    const components = resolve(root, '..', '..', 'components');
    const opened = {
      app,
      page,
      logs,
      root,
      panelFile: join(components, 'Panel.ucf'),
      noStyleFile: join(components, 'svelte', 'NoStyle.ucf'),
      messages: collectConsole(page),
      requests: trackRequests(page),
      payloads: trackHmrPayloads(page),
      loads: 0,
      close,
    };
    page.on('load', () => void opened.loads++);
    await page.goto(app.url);
    await page.locator(SVELTE_PANEL).waitFor();
    await page.evaluate(() => void ((globalThis as {ucfMarker?: string}).ucfMarker = 'kept'));
    return opened;
  } catch (err) {
    await close();
    throw err;
  }
}

async function edit(opened: Opened, from: string, to: string, file = opened.panelFile) {
  opened.payloads.clear();
  await editFile(opened.requests, file, from, to);
}

const marker = ({page}: Opened) => page.evaluate(() => (globalThis as {ucfMarker?: string}).ucfMarker);
const svelteHeading = ({page}: Opened) => page.locator(`${SVELTE_PANEL} .heading`).textContent();
const sveltePadding = ({page}: Opened) => computed(page.locator(SVELTE_PANEL), 'padding-top');
const svelteModule = ({panelFile}: Opened) => `${panelFile}.svelte.svelte`;
const styleModule = ({panelFile}: Opened, index: number) => `/@fs${panelFile}?ucf&type=style&index=${index}&lang.css`;

async function expectNoError(opened: Opened) {
  expect(opened.payloads.errors()).toEqual([]);
  expect(await opened.page.locator('vite-error-overlay').count()).toBe(0);
  expect(opened.logs).toEqual([]);
}

// Svelte 5 HMR mounts the component again: the new text and the kept window value show no page reload.
async function svelteEdit(opened: Opened) {
  await edit(opened, '{$style.title}">{heading}</h3>', '{$style.title}">{heading}!</h3>');
  await expect.poll(() => svelteHeading(opened), POLL).toBe('Svelte panel!');
  // Also spaces the next write past the watcher's 50 ms per-file change throttle.
  await opened.requests.quiet(500);

  expect(opened.requests.paths()).toEqual([svelteModule(opened)]);
  expect(opened.payloads.updatedPaths()).toEqual([svelteModule(opened)]);
  expect(opened.payloads.fullReloads()).toBe(0);
  expect(await marker(opened)).toBe('kept');
  await expectNoError(opened);
}

async function scopedStyleEdit(opened: Opened) {
  expect(await sveltePadding(opened)).toBe('16px');
  const before = await opened.page.locator(SVELTE_PANEL).elementHandle();
  await edit(opened, '$pad: 1rem;', '$pad: 2rem;');
  await expect.poll(() => sveltePadding(opened), POLL).toBe('32px');
  await opened.requests.quiet(500);

  expect(await marker(opened)).toBe('kept');
  await expectNoError(opened);
  // Still the same DOM node.
  expect(
    await before.evaluate((element, selector) => element === element.ownerDocument.querySelector(selector), SVELTE_PANEL)
  ).toBe(true);
}

async function expectCleanConsole(opened: Opened) {
  expect(opened.loads).toBe(1);
  expect(opened.messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
}

describe('Svelte HMR in apps/svelte-vite', () => {
  let opened: Opened;

  beforeAll(async () => {
    opened = await openApp('svelte-vite');
  });

  afterAll(async () => {
    await opened?.close();
  });

  it('a <svelte> edit updates the Svelte module without a reload or an error', async () => {
    await svelteEdit(opened);
  });

  it('a <style scoped> edit fetches only its CSS module and keeps the Svelte element', async () => {
    await scopedStyleEdit(opened);

    expect(opened.requests.paths()).toEqual([styleModule(opened, 0)]);
    expect(opened.payloads.updatedPaths()).toEqual([styleModule(opened, 0)]);
    expect(opened.payloads.fullReloads()).toBe(0);
  });

  it('loaded the page once and logged no warning or error', async () => {
    await expectCleanConsole(opened);
  });
});

describe('Svelte HMR beside Vue and React in apps/all-targets', () => {
  let opened: Opened;
  const count = () => opened.page.locator('#react .counter button').textContent();

  beforeAll(async () => {
    opened = await openApp('all-targets');
  });

  afterAll(async () => {
    await opened?.close();
  });

  it('renders Panel.ucf as Vue, React and Svelte, and counts React clicks from 2', async () => {
    expect(await opened.page.locator('#vue .heading').textContent()).toBe('Vue panel');
    expect(await opened.page.locator('#react .heading').textContent()).toBe('React panel');
    expect(await svelteHeading(opened)).toBe('Svelte panel');
    await expect.poll(count).toBe('2');
    await opened.page.locator('#react .counter button').click();
    await expect.poll(count).toBe('3');
    await opened.requests.quiet(500);
  });

  it('a <react> edit updates only the React module', async () => {
    const reactModule = `${opened.panelFile}.react.tsx`;
    await edit(opened, '<h3 className="heading">{heading}</h3>', '<h3 className="heading">{heading}!</h3>');
    await expect.poll(() => opened.page.locator('#react .heading').textContent(), POLL).toBe('React panel!');
    await opened.requests.quiet(500);

    expect(opened.requests.paths()).toEqual([reactModule]);
    expect(opened.payloads.updatedPaths()).toEqual([reactModule]);
    expect(await count()).toBe('3');
    await expectNoError(opened);
  });

  it('a <svelte> edit updates the Svelte module and the React counter keeps its state', async () => {
    await svelteEdit(opened);
    expect(await count()).toBe('3');
  });

  it('a <style scoped> edit fetches only its style modules and keeps the Svelte element', async () => {
    await scopedStyleEdit(opened);

    // Ours for React and Svelte, plugin-vue's sub-module for the Vue panel.
    const ours = `/@fs${opened.panelFile}?ucf&type=style&index=0&`;
    const vues = `/@fs${opened.panelFile}?vue&type=style&index=0&`;
    for (const paths of [opened.requests.paths(), opened.payloads.updatedPaths()]) {
      expect(paths).toContain(styleModule(opened, 0));
      for (const path of paths) expect(path.startsWith(ours) || path.startsWith(vues), path).toBe(true);
    }
    expect(opened.payloads.fullReloads()).toBe(0);
    expect(await count()).toBe('3');
  });

  it('a <svelte> edit to a file with no <vue> block updates its Svelte module', async () => {
    const noStyleModule = `${opened.noStyleFile}.svelte.svelte`;
    await edit(opened, 'No script, no style', 'No script, no style!', opened.noStyleFile);
    await expect.poll(() => opened.page.locator('#no-style .plain').textContent(), POLL).toBe('No script, no style!');
    await opened.requests.quiet(500);

    expect(opened.requests.paths()).toEqual([noStyleModule]);
    expect(opened.payloads.updatedPaths()).toEqual([noStyleModule]);
    expect(opened.payloads.fullReloads()).toBe(0);
    expect(await marker(opened)).toBe('kept');
    await expectNoError(opened);
  });

  it('a plain .svelte file still hot-updates its markup and its style through plugin-svelte', async () => {
    const plainFile = join(opened.root, 'src', 'Plain.svelte');
    const plain = opened.page.locator('#plain .plain');
    await edit(opened, 'Plain svelte</p>', 'Plain svelte!</p>', plainFile);
    await expect.poll(() => plain.textContent(), POLL).toBe('Plain svelte!');
    await opened.requests.quiet(500);
    await edit(opened, 'rgb(1, 2, 3)', 'rgb(4, 5, 6)', plainFile);
    await expect.poll(() => computed(plain, 'color'), POLL).toBe('rgb(4, 5, 6)');
    await opened.requests.quiet(500);

    expect(opened.payloads.fullReloads()).toBe(0);
    expect(await marker(opened)).toBe('kept');
    await expectNoError(opened);
  });

  it('loaded the page once and logged no warning or error', async () => {
    await expectCleanConsole(opened);
  });
});
