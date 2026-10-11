import {readFile, writeFile} from 'node:fs/promises';
import {expect} from 'vitest';
import type {Page} from 'playwright';
import type {HotPayload} from 'vite';

export function trackRequests(page: Page) {
  const urls: string[] = [];
  let inFlight = 0;
  let lastActivity = 0;
  page.on('request', (request) => {
    urls.push(request.url());
    inFlight++;
    lastActivity = Date.now();
  });
  const settled = () => {
    inFlight--;
    lastActivity = Date.now();
  };
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  return {
    /** Requests since `clear()`, minus Vite's `t=` cache buster. */
    paths: () =>
      urls.map((url) => {
        const {pathname, searchParams} = new URL(url);
        searchParams.delete('t');
        const query = searchParams.toString().replace(/=(?=&|$)/g, '');
        return query ? `${pathname}?${query}` : pathname;
      }),
    clear: () => void (urls.length = 0),
    // `networkidle` resolves at once if already reached; this waits for an update's own requests.
    async quiet(ms: number, since = 0) {
      lastActivity = Math.max(lastActivity, since);
      await expect.poll(() => inFlight === 0 && Date.now() - lastActivity >= ms, {timeout: 10_000, interval: 50}).toBe(true);
    },
  };
}

/** Clears `requests` before the write, so they count from the edit. */
export async function editFile(requests: ReturnType<typeof trackRequests>, file: string, from: string, to: string) {
  const source = await readFile(file, 'utf8');
  expect(source).toContain(from);
  requests.clear();
  await writeFile(file, source.replace(from, to));
}

/** Vite's HMR messages to the page, read off its websocket. */
export function trackHmrPayloads(page: Page) {
  const payloads: HotPayload[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({payload}) => {
      if (typeof payload === 'string') payloads.push(JSON.parse(payload) as HotPayload);
    });
  });
  return {
    clear: () => void (payloads.length = 0),
    /** The paths of every `update` since `clear()`. */
    updatedPaths: () => payloads.flatMap((payload) => (payload.type === 'update' ? payload.updates.map(({path}) => path) : [])),
    fullReloads: () => payloads.filter((payload) => payload.type === 'full-reload').length,
  };
}
