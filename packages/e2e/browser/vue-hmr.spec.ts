import {once} from 'node:events';
import {resolve} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {editFile, trackHmrPayloads, trackRequests} from './lib/requests.ts';
import {startDev} from './lib/serve.ts';

const COUNTER = '.counter';
const POLL = {timeout: 10_000};

let browser: Browser | undefined;
let root: string | undefined;
let app: Awaited<ReturnType<typeof startDev>> | undefined;
let page: Page;
let counterFile: string;
let counterUrl: string;
let messages: ReturnType<typeof collectConsole>;
let requests: ReturnType<typeof trackRequests>;
let payloads: ReturnType<typeof trackHmrPayloads>;
let loads = 0;

async function edit(from: string, to: string) {
  payloads.clear();
  await editFile(requests, counterFile, from, to);
}

const count = () => page.locator(`${COUNTER} button`).textContent();

beforeAll(async () => {
  browser = await launchChromium();
  root = await copyApp('vue');
  // The copy imports `../../../components/Counter.ucf` from `src/App.vue`.
  counterFile = resolve(root, '..', '..', 'components', 'Counter.ucf');
  counterUrl = `/@fs${counterFile}`;
  app = await startDev(root);
  page = await browser.newPage();
  messages = collectConsole(page);
  page.on('load', () => void loads++);
  requests = trackRequests(page);
  payloads = trackHmrPayloads(page);
  await page.goto(app.url);
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await app?.close();
  if (root) await removeApp(root);
});

describe('HMR of a Vue .ucf component (apps/vue, Counter clicked to 3)', () => {
  it('counts clicks from its start of 2', async () => {
    await expect.poll(count).toBe('2');
    await page.locator(`${COUNTER} button`).click();
    await expect.poll(count).toBe('3');
    await requests.quiet(500);
  });

  it('a <template> edit re-renders the Vue module and keeps the count', async () => {
    await edit('<span class="label">Clicks</span>', '<span class="label">Hits</span>');
    await expect.poll(() => page.locator(`${COUNTER} .label`).textContent(), POLL).toBe('Hits');
    // Also spaces the next write past the watcher's 50 ms per-file change throttle.
    await requests.quiet(500);

    expect(await count()).toBe('3');
    expect(payloads.updatedPaths()).toEqual([counterUrl]);
    expect(payloads.fullReloads()).toBe(0);
    expect(loads).toBe(1);
  });

  it('a <style scoped> edit updates only its style sub-module and keeps the count', async () => {
    await edit('rgb(120, 40, 160)', 'rgb(10, 20, 30)');
    await expect.poll(() => computed(page.locator(COUNTER), 'color'), POLL).toBe('rgb(10, 20, 30)');
    await requests.quiet(500);

    expect(await count()).toBe('3');
    const paths = payloads.updatedPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith(`${counterUrl}?vue&type=style&index=0&`)).toBe(true);
    expect(payloads.fullReloads()).toBe(0);
  });

  it('a <react> edit sends no update and requests nothing', async () => {
    const changed = once(app!.server.watcher, 'change');
    await edit('<span className="label">Clicks</span>', '<span className="label">Taps</span>');
    expect((await changed)[0]).toBe(counterFile);
    // The window counts from the change, not from the previous test's last request.
    const changedAt = Date.now();
    await app!.server.environments.client.waitForRequestsIdle();
    // Nothing shows a hot update that sends nothing: give a wrong one time to arrive.
    await requests.quiet(1000, changedAt);

    expect(requests.paths()).toEqual([]);
    expect(payloads.updatedPaths()).toEqual([]);
    expect(payloads.fullReloads()).toBe(0);
    expect(await count()).toBe('3');
    expect(await page.locator(`${COUNTER} .label`).textContent()).toBe('Hits');
  });

  it('a <template> edit that starts using a script import reloads the component', async () => {
    await edit('<span class="label">Hits</span>', '<span class="label">{{ typeof ref }}</span>');
    // A re-render would keep the old setup, which returns no `ref`: the text would read `undefined`.
    await expect.poll(() => page.locator(`${COUNTER} .label`).textContent(), POLL).toBe('function');
    await requests.quiet(500);

    // Mounted again from its start of 2.
    expect(await count()).toBe('2');
    expect(payloads.updatedPaths()).toEqual([counterUrl]);
    expect(payloads.fullReloads()).toBe(0);
  });

  it('loaded the page once and logged no warning or error', () => {
    expect(loads).toBe(1);
    expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
  });
});
