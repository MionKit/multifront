import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {expectCspEnforced, expectStyledCard, manifestGraph, openPage, readDist, runInApp, serveConsumerApp} from './lib/app.ts';

const served = serveConsumerApp({
  target: 'vue',
  template: 'consumer-vite-vue',
  build: ['pnpm', 'exec', 'vite', 'build', '--manifest'],
  serve: (port) => ['pnpm', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort'],
});

function cssOf(entry: string): string {
  const {app} = served();
  return manifestGraph(app, entry)
    .css.map((file) => readDist(app, file))
    .join('\n');
}

describe('the packed Vue package in a fresh Vite Vue app', () => {
  it('installs the tarball and no multifront package', () => {
    const installed = readdirSync(join(served().app.dir, 'node_modules', '.pnpm'));
    expect(installed.some((name) => name.startsWith('@mf-fixture+ui-vue@'))).toBe(true);
    expect(installed.filter((name) => name.startsWith('@multifront+'))).toEqual([]);
  });

  it('type checks with real vue-tsc: the one wrong prop is the expected error', async () => {
    const {code, output} = await runInApp(served().app, ['pnpm', 'exec', 'vue-tsc', '--noEmit', '--pretty', 'false']);
    expect(output.trim(), output).toBe('');
    expect(code).toBe(0);
  });

  it('builds with real vite build', () => {
    expect(served().build).toContain('built in');
  });

  it('renders Card, Counter, Button and VueOnly with the library CSS, no console problem and no CSP violation', async () => {
    const {page, messages, close} = await openPage(served().url);
    try {
      await expectStyledCard(page);

      const counter = page.locator('button.counter');
      expect(await counter.textContent()).toBe('Count 0');
      await counter.click();
      await expect.poll(() => counter.textContent()).toBe('Count 1');
      expect(await computed(counter, 'color')).toBe('rgb(120, 40, 160)');

      const button = page.locator('button', {hasText: 'Go'});
      const classes = (await button.getAttribute('class'))!.split(' ');
      expect(classes).toContain('extra');
      expect(classes.filter((name) => name.startsWith('button_'))).toHaveLength(1);
      expect(await computed(button, 'color')).toBe('rgb(255, 0, 0)');
      expect(await computed(button, 'font-weight')).toBe('600');
      await button.click();
      await expect.poll(() => page.locator('#clicks').textContent()).toBe('1');

      expect(await computed(page.locator('details.vue-only'), 'padding')).toBe('4px');

      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('enforces the CSP: an inline style is refused and reported', () => expectCspEnforced(served().url));

  it('styles.css brings every component CSS to a page that imports only Card', async () => {
    // Badge, Counter and VueOnly are not imported by the styles page, nor Badge by the main page.
    const stylesCss = cssOf('styles.html');
    for (const rule of ['.badge[', '.counter[', '.vue-only[']) expect(stylesCss).toContain(rule);
    expect(cssOf('index.html')).not.toContain('.badge[');

    const {page, messages, close} = await openPage(new URL('styles.html', served().url).href);
    try {
      await expectStyledCard(page);
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });
});
