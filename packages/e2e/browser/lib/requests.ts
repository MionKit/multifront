import {readFile, writeFile} from 'node:fs/promises';
import {expect} from 'vitest';
import type {Page} from 'playwright';

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
    /** Path and query of each request since `clear()`, without Vite's `t=` cache buster. */
    paths: () =>
      urls.map((url) => {
        const {pathname, searchParams} = new URL(url);
        searchParams.delete('t');
        const query = searchParams.toString().replace(/=(?=&|$)/g, '');
        return query ? `${pathname}?${query}` : pathname;
      }),
    clear: () => void (urls.length = 0),
    /** No request in flight and none started or ended for `ms`, nor since `since`. */
    // `networkidle` resolves at once once reached; this waits for an update's own requests to end.
    async quiet(ms: number, since = 0) {
      lastActivity = Math.max(lastActivity, since);
      await expect.poll(() => inFlight === 0 && Date.now() - lastActivity >= ms, {timeout: 10_000, interval: 50}).toBe(true);
    },
  };
}

/** Replaces `from` (which must be there) with `to` in `file`, after clearing `requests`. */
export async function editFile(requests: ReturnType<typeof trackRequests>, file: string, from: string, to: string) {
  const source = await readFile(file, 'utf8');
  expect(source).toContain(from);
  requests.clear();
  await writeFile(file, source.replace(from, to));
}
