import {expect} from 'vitest';
import type {Page} from 'playwright';

export interface RequestLog {
  /** Path and query of each request since `clear()`, without Vite's `t=` cache buster. */
  paths(): string[];
  clear(): void;
  /** No request in flight and none started or ended for `ms`, nor since `since`. */
  quiet(ms: number, since?: number): Promise<void>;
}

export function trackRequests(page: Page): RequestLog {
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
    paths: () =>
      urls.map((url) => {
        const {pathname, searchParams} = new URL(url);
        searchParams.delete('t');
        const query = searchParams.toString().replace(/=(?=&|$)/g, '');
        return query ? `${pathname}?${query}` : pathname;
      }),
    clear: () => void (urls.length = 0),
    // `networkidle` resolves at once once reached; this waits for an update's own requests to end.
    async quiet(ms, since = 0) {
      lastActivity = Math.max(lastActivity, since);
      await expect.poll(() => inFlight === 0 && Date.now() - lastActivity >= ms, {timeout: 10_000, interval: 50}).toBe(true);
    },
  };
}
