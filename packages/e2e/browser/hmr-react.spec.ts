import {once} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {trackRequests, type RequestLog} from './lib/requests.ts';
import {startDev} from './lib/serve.ts';

const COUNTER = '[data-demo="counter"]';
const POLL = {timeout: 10_000};

let browser: Browser | undefined;
let root: string | undefined;
let app: Awaited<ReturnType<typeof startDev>> | undefined;
let page: Page;
let counterFile: string;
let messages: ReturnType<typeof collectConsole>;
let requests: RequestLog;
let loads = 0;

async function edit(from: string, to: string): Promise<void> {
  const source = await readFile(counterFile, 'utf8');
  expect(source).toContain(from);
  requests.clear();
  await writeFile(counterFile, source.replace(from, to));
}

beforeAll(async () => {
  browser = await launchChromium();
  root = await copyApp('demo');
  // The copy imports `../../../components/Counter.ucf` from `src/App.tsx`.
  counterFile = resolve(root, '..', '..', 'components', 'Counter.ucf');
  app = await startDev(root);
  page = await browser.newPage();
  messages = collectConsole(page);
  page.on('load', () => void loads++);
  requests = trackRequests(page);
  await page.goto(app.url);
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await app?.close();
  if (root) await removeApp(root);
});

describe('HMR of a React .ucf component (demo, Counter clicked to 3)', () => {
  it('counts clicks', async () => {
    const button = page.locator(`${COUNTER} button`);
    for (let click = 0; click < 3; click++) await button.click();
    await expect.poll(() => button.textContent()).toBe('3');
    await requests.quiet(500);
  });

  it('a <style scoped> edit requests only that style module and keeps the count', async () => {
    await edit('rgb(120, 40, 160)', 'rgb(10, 20, 30)');
    await expect.poll(() => computed(page.locator(`${COUNTER} .counter`), 'color'), POLL).toBe('rgb(10, 20, 30)');
    // Also keeps the next write past the watcher's 50 ms throttle of change events on one file.
    await requests.quiet(500);

    expect(await page.locator(`${COUNTER} button`).textContent()).toBe('3');
    expect(requests.paths()).toEqual([`/@fs${counterFile}?ucf&type=style&index=0&lang.css`]);
  });

  it('a <react> edit requests only the React module, keeps the count and loads no page', async () => {
    await edit('<span className="label">Clicks</span>', '<span className="label">Taps</span>');
    await expect.poll(() => page.locator(`${COUNTER} .label`).textContent(), POLL).toBe('Taps');
    await requests.quiet(500);

    expect(await page.locator(`${COUNTER} button`).textContent()).toBe('3');
    expect(requests.paths()).toEqual([`${counterFile}.react.tsx`]);
    expect(loads).toBe(1);
  });

  it('a <vue> edit requests nothing', async () => {
    const changed = once(app!.server.watcher, 'change');
    await edit('<span class="label">Clicks</span>', '<span class="label">Hits</span>');
    expect((await changed)[0]).toBe(counterFile);
    // The window counts from the change, not from the previous test's last request.
    const changedAt = Date.now();
    await app!.server.environments.client.waitForRequestsIdle();
    // Nothing shows a hot update that sends nothing: give a wrong one time to arrive.
    await requests.quiet(1000, changedAt);

    expect(requests.paths()).toEqual([]);
    expect(await page.locator(`${COUNTER} button`).textContent()).toBe('3');
    expect(await page.locator(`${COUNTER} .label`).textContent()).toBe('Taps');
  });

  it('loaded the page once and logged no warning or error', () => {
    expect(loads).toBe(1);
    expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
  });
});
