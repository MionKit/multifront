import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {createConsumerApp, freePort, manifestGraph, openPage, readDist, runInApp, serveApp} from './lib/app.ts';
import type {ConsumerApp} from './lib/app.ts';
import {fixtureTarballs, scopeAttribute} from './lib/pack.ts';

type Served = Awaited<ReturnType<typeof serveApp>>;

let packed: Awaited<ReturnType<typeof fixtureTarballs>> | undefined;
let app: ConsumerApp | undefined;
let server: Served | undefined;
let build = '';
let setup: Promise<void> | undefined;

beforeAll(() => {
  setup = (async () => {
    packed = await fixtureTarballs();
    const tarball = packed.tarballs.vue;
    if (!tarball) throw new Error(`no vue tarball among ${JSON.stringify(packed.tarballs)}`);
    app = await createConsumerApp('consumer-vite-vue', [tarball]);
    const built = await runInApp(app, ['pnpm', 'exec', 'vite', 'build', '--sourcemap', '--manifest']);
    build = built.output;
    if (built.code !== 0) throw new Error(`vite build failed:\n${built.output}`);
    const port = await freePort();
    server = await serveApp(app, ['pnpm', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort'], port);
  })();
  return setup;
}, 240_000);

afterAll(async () => {
  // A timed-out setup keeps running: what it creates late must be removed too.
  await setup?.catch(() => {});
  await server?.close();
  await app?.remove();
  await packed?.remove();
});

function cssOf(entry: string): string {
  return manifestGraph(app!, entry)
    .css.map((file) => readDist(app!, file))
    .join('\n');
}

/** Card as the library CSS styles it, with the scope attribute React stamps too (vite-react.spec.ts). */
async function expectStyledCard(page: Page): Promise<void> {
  const card = page.locator('article.card');
  await card.waitFor();
  expect(await computed(card, 'padding')).toBe('16px');
  expect(await computed(card, 'color')).toBe('rgb(30, 60, 90)');
  expect(await computed(card.locator('h2'), 'color')).toBe('rgb(150, 40, 60)');
  expect(await card.getAttribute(scopeAttribute('Card.ucf'))).toBe('');
}

describe('the packed Vue package in a fresh Vite Vue app', () => {
  it('installs the tarball and no multifront package', () => {
    const installed = readdirSync(join(app!.dir, 'node_modules', '.pnpm'));
    expect(installed.some((name) => name.startsWith('@mf-fixture+ui-vue@'))).toBe(true);
    expect(installed.filter((name) => name.startsWith('@multifront+'))).toEqual([]);
  });

  it('type checks with real vue-tsc: the one wrong prop is the expected error', async () => {
    const {code, output} = await runInApp(app!, ['pnpm', 'exec', 'vue-tsc', '--noEmit', '--pretty', 'false']);
    expect(output.trim(), output).toBe('');
    expect(code).toBe(0);
  });

  it('builds with real vite build', () => {
    expect(build).toContain('built in');
  });

  it('renders Card, Counter, Button and VueOnly with the library CSS, no console problem and no CSP violation', async () => {
    const {page, messages, close} = await openPage(server!.url);
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

  it('enforces the CSP: an inline style is refused and reported', async () => {
    const {page, messages, close} = await openPage(server!.url);
    try {
      await page.locator('article.card').waitFor();
      const injected = await page.addStyleTag({content: 'body { color: red; }'}).then(
        () => 'applied',
        (err: Error) => err.message
      );
      expect(injected).toContain('Content Security Policy');
      await expect
        .poll(() => consoleProblems(messages).map(({text}) => text))
        .toContainEqual(expect.stringContaining('CSP violation'));
    } finally {
      await close();
    }
  });

  it('styles.css brings every component CSS to a page that imports only Card', async () => {
    // Badge, Counter and VueOnly are not imported by the styles page, nor Badge by the main page.
    const stylesCss = cssOf('styles.html');
    for (const rule of ['.badge[', '.counter[', '.vue-only[']) expect(stylesCss).toContain(rule);
    expect(cssOf('index.html')).not.toContain('.badge[');

    const {page, messages, close} = await openPage(new URL('styles.html', server!.url).href);
    try {
      await expectStyledCard(page);
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });
});
