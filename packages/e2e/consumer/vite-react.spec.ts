import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {expectCspEnforced, expectStyledCard, manifestGraph, openPage, readDist, runInApp, serveConsumerApp} from './lib/app.ts';

const served = serveConsumerApp({
  target: 'react',
  template: 'consumer-vite-react',
  build: ['pnpm', 'exec', 'vite', 'build', '--sourcemap', '--manifest'],
  serve: (port) => ['pnpm', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort'],
});

function sourcesOf(js: string[]): string[] {
  return js.flatMap((file) => (JSON.parse(readDist(served().app, `${file}.map`)) as {sources: string[]}).sources);
}

const PACKAGE = '/node_modules/@mf-fixture/ui-react/';
const COUNTER_MODULES = /\/node_modules\/@mf-fixture\/ui-react\/(Counter|hooks\/useToggle)\.js$/;

describe('the packed React package in a fresh Vite React app', () => {
  it('installs the tarball and no multifront package', () => {
    const installed = readdirSync(join(served().app.dir, 'node_modules', '.pnpm'));
    expect(installed.some((name) => name.startsWith('@mf-fixture+ui-react@'))).toBe(true);
    expect(installed.filter((name) => name.startsWith('@multifront+'))).toEqual([]);
  });

  it('type checks with real tsc: the one wrong prop is the expected error', async () => {
    const {code, output} = await runInApp(served().app, ['pnpm', 'exec', 'tsc', '--noEmit', '--pretty', 'false']);
    expect(output.trim(), output).toBe('');
    expect(code).toBe(0);
  });

  it('builds with real vite build, on production React', () => {
    expect(served().build).toContain('built in');
    const sources = sourcesOf(manifestGraph(served().app, 'index.html').js);
    expect(sources.filter((source) => source.endsWith('.development.js'))).toEqual([]);
    expect(sources.some((source) => source.endsWith('.production.js'))).toBe(true);
  });

  it('renders Card, Counter and Button with the library CSS, no console problem and no CSP violation', async () => {
    const {page, messages, close} = await openPage(served().url);
    try {
      await expectStyledCard(page);

      const counter = page.locator('button.counter');
      expect(await counter.textContent()).toBe('Count 0');
      await counter.click();
      await expect.poll(() => counter.textContent()).toBe('Count 1');

      const button = page.locator('button', {hasText: 'Go'});
      const classes = (await button.getAttribute('class'))!.split(' ');
      expect(classes).toContain('extra');
      expect(classes.filter((name) => name.startsWith('button_'))).toHaveLength(1);
      expect(await computed(button, 'color')).toBe('rgb(255, 0, 0)');
      expect(await computed(button, 'font-weight')).toBe('600');
      await expect.poll(() => page.locator('#button-ref').textContent()).toBe('BUTTON');

      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('enforces the CSP: an inline style is refused and reported', () => expectCspEnforced(served().url));

  it('only-card bundles Card and its CSS, never Counter code or CSS (sideEffects)', () => {
    const onlyCard = manifestGraph(served().app, 'src/only-card.tsx');
    const onlyCardSources = sourcesOf(onlyCard.js);
    expect(onlyCardSources.some((source) => source.endsWith(`${PACKAGE}Card.js`))).toBe(true);
    expect(onlyCardSources.filter((source) => COUNTER_MODULES.test(source))).toEqual([]);
    const onlyCardCss = onlyCard.css.map((file) => readDist(served().app, file)).join('\n');
    expect(onlyCardCss).toContain('--card-padding');
    expect(onlyCardCss).not.toContain('.counter');

    const main = manifestGraph(served().app, 'index.html');
    expect(sourcesOf(main.js).filter((source) => COUNTER_MODULES.test(source))).toHaveLength(2);
    expect(main.css.map((file) => readDist(served().app, file)).join('\n')).toContain('.counter');
  });
});
