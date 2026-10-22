import {readdirSync} from 'node:fs';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {consoleProblems} from '../browser/lib/chromium.ts';
import {scopeAttribute} from '../browser/lib/scope.ts';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {
  KEY_STYLES,
  expectHydrates,
  expectStyledCard,
  freePort,
  keyStyles,
  openPage,
  serveApp,
  serveConsumerApp,
  svelteCheck,
} from './lib/app.ts';

const WRONG_PROP_PAGE = `<script lang="ts">\n  import {Card} from '@mf-fixture/ui-svelte';\n</script>\n\n<Card titel="x" />\n`;

const served = serveConsumerApp({
  target: 'svelte',
  template: 'consumer-sveltekit',
  build: ['pnpm', 'exec', 'vite', 'build'],
  // adapter-node takes its port from the env only.
  serve: (port) => ['env', `PORT=${port}`, 'node', 'build'],
});

const cardAttribute = scopeAttribute(LIBRARY_DIR, join(LIBRARY_DIR, 'src', 'Card.front'), true);
const counterAttribute = scopeAttribute(LIBRARY_DIR, join(LIBRARY_DIR, 'src', 'Counter.front'), true);

async function clicksAndKeyStyles(page: Page): Promise<void> {
  await page.locator('button', {hasText: 'Go'}).click();
  await expect.poll(() => page.locator('#clicks').textContent()).toBe('1');
  expect(await keyStyles(page)).toEqual(KEY_STYLES);
}

describe('the packed Svelte package in a fresh SvelteKit app', () => {
  it('installs the tarball and no multifront package', () => {
    const installed = readdirSync(join(served().app.dir, 'node_modules', '.pnpm'));
    expect(installed.some((name) => name.startsWith('@mf-fixture+ui-svelte@'))).toBe(true);
    expect(installed.filter((name) => name.startsWith('@multifront+'))).toEqual([]);
  });

  it('type checks with real svelte-check, warnings included', async () => {
    const {code, output} = await svelteCheck(served().app);
    expect(output).toContain(' 0 ERRORS 0 WARNINGS ');
    expect(code, output).toBe(0);
  });

  it('fails svelte-check on a page with a wrong prop', async () => {
    const dir = join(served().app.dir, 'src', 'routes', 'wrong');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, '+page.svelte'), WRONG_PROP_PAGE);
    try {
      const {code, output} = await svelteCheck(served().app);
      expect(code, output).toBe(1);
      const errors = output.split('\n').filter((line) => line.includes(' ERROR '));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"src/routes/wrong/+page.svelte"');
      expect(errors[0]).toContain('titel');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('builds with real vite build and adapter-node', () => {
    const {build} = served();
    expect(build).toContain('built in');
    expect(build).toContain('Using @sveltejs/adapter-node');
  });

  it('server renders the scoped elements, styled from a CSS file with JavaScript off', async () => {
    const {url} = served();
    const html = await (await fetch(url)).text();
    expect(html).toContain(`<article ${cardAttribute}=""`);
    expect(html).toContain(`<button ${counterAttribute}=""`);
    expect(html).not.toContain('<style');
    const links = [...html.matchAll(/<link href="([^"]+\.css)" rel="stylesheet">/g)].map(([, href]) => href!);
    expect(links).not.toEqual([]);
    const css = (await Promise.all(links.map(async (href) => (await fetch(new URL(href, url))).text()))).join('\n');
    expect(css).toContain('--card-padding');
    expect(css).toContain('.counter[data-v-');

    const {page, messages, close} = await openPage(url, false);
    try {
      await expectStyledCard(page);
      expect(await page.locator('button.counter').textContent()).toBe('Count 0');
      // No script ran, so this is the server's HTML.
      expect(await page.locator('body').getAttribute('data-hydrated')).toBeNull();
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });

  // Svelte's production hydration warning is a console warning, so the console check covers it.
  it('hydrates under the node server: clicks work, key styles match, no console problem', () =>
    expectHydrates(served().url, 'button.counter', clicksAndKeyStyles));

  describe('under vite dev', () => {
    let starting: ReturnType<typeof serveApp> | undefined;

    beforeAll(async () => {
      const port = await freePort();
      starting = serveApp(served().app, ['pnpm', 'exec', 'vite', 'dev', '--port', String(port), '--strictPort'], port);
      await starting;
    });

    afterAll(async () => {
      // A timed-out setup keeps running: the server it starts late must be closed too.
      await (await starting?.catch(() => undefined))?.close();
    });

    // Dev Svelte prints every hydration warning; production only the mismatch one.
    it('hydrates with no hydration warning and counts a click', async () =>
      expectHydrates((await starting!).url, 'button.counter', clicksAndKeyStyles));
  });
});
