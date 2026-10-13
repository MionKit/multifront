import {execFile} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import type {Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {createConsumerApp, expectStyledCard, freePort, openPage, runInApp, serveApp, serveConsumerApp} from './lib/app.ts';
import type {ConsumerApp} from './lib/app.ts';
import {packLibrary} from './lib/pack.ts';

const run = promisify(execFile);

const NEXT_BUILD: [string, ...string[]] = ['pnpm', 'exec', 'next', 'build'];
const USE_CLIENT = '"use client";\n';

const served = serveConsumerApp({
  target: 'react',
  template: 'consumer-next',
  build: NEXT_BUILD,
  serve: (port) => ['pnpm', 'exec', 'next', 'start', '--port', String(port)],
});

/** The React tarball repacked with the directive cut from `Counter.js`. */
async function withoutUseClient(tarball: string): Promise<{tarball: string; remove: () => Promise<void>}> {
  const dir = await mkdtemp(join(tmpdir(), 'mf-no-use-client-'));
  const remove = () => rm(dir, {recursive: true, force: true});
  try {
    await mkdir(join(dir, 'react'));
    await run('tar', ['-xzf', tarball, '-C', join(dir, 'react'), '--strip-components=1']);
    const counter = join(dir, 'react', 'Counter.js');
    const source = await readFile(counter, 'utf8');
    if (!source.startsWith(USE_CLIENT)) throw new Error(`Counter.js does not start with ${USE_CLIENT}`);
    await writeFile(counter, source.slice(USE_CLIENT.length));
    const {react} = await packLibrary(dir);
    return {tarball: react!, remove};
  } catch (err) {
    await remove();
    throw err;
  }
}

async function expectHydratedCounter(page: Page): Promise<void> {
  await page.locator('body[data-hydrated]').waitFor({state: 'attached'});
  const counter = page.locator('section.panel button.counter');
  expect(await counter.textContent()).toBe('Count 0');
  await counter.click();
  await expect.poll(() => counter.textContent()).toBe('Count 1');
}

describe('the packed React package in a fresh Next.js App Router app', () => {
  it('installs the tarball and no multifront package', () => {
    const installed = readdirSync(join(served().app.dir, 'node_modules', '.pnpm'));
    expect(installed.some((name) => name.startsWith('@mf-fixture+ui-react@'))).toBe(true);
    expect(installed.filter((name) => name.startsWith('@multifront+'))).toEqual([]);
  });

  it('builds with real next build, type checked, with no warning', () => {
    const {build} = served();
    expect(build).toContain('Compiled successfully');
    expect(build).toContain('Finished TypeScript');
    expect(build).not.toContain('⚠');
  });

  it('fails next build once Counter.js loses its "use client"', async () => {
    const stripped = await withoutUseClient(served().tarball);
    let app: ConsumerApp | undefined;
    try {
      app = await createConsumerApp('consumer-next', [stripped.tarball]);
      const {code, output} = await runInApp(app, NEXT_BUILD);
      expect(code, output).not.toBe(0);
      expect(output).toContain('Error occurred prerendering page "/"');
      expect(output).toContain('useState) is not a function');
    } finally {
      await app?.remove();
      await stripped.remove();
    }
  }, 240_000);

  it('server renders the page styled: with JavaScript off, the library CSS comes from a <link>', async () => {
    const {url} = served();
    const html = await (await fetch(url)).text();
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"/g)].map(([, href]) => href!);
    expect(links).not.toEqual([]);
    const css = (await Promise.all(links.map(async (href) => (await fetch(new URL(href, url))).text()))).join('\n');
    expect(css).toContain('--card-padding');
    expect(css).toContain('.counter[data-v-');

    const {page, messages, close} = await openPage(url, {javaScript: false});
    try {
      await expectStyledCard(page);
      expect(await page.locator('section.panel button.counter').textContent()).toBe('Count 0');

      // Root props a server component passes to a client one.
      const button = page.locator('button', {hasText: 'Go'});
      const classes = (await button.getAttribute('class'))!.split(' ');
      expect(classes).toContain('extra');
      expect(classes.filter((name) => name.startsWith('button_'))).toHaveLength(1);
      expect(await computed(button, 'color')).toBe('rgb(255, 0, 0)');
      expect(await computed(button, 'font-weight')).toBe('600');

      expect(await computed(page.locator('span.tooltip'), 'text-decoration-line')).toBe('underline');
      expect(await computed(page.locator('label.field'), 'display')).toBe('flex');
      // No script ran, so this is the server's HTML.
      expect(await page.locator('body').getAttribute('data-hydrated')).toBeNull();
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('hydrates under next start: Counter counts inside the server-rendered Panel, no console problem', async () => {
    const {page, messages, close} = await openPage(served().url);
    try {
      await expectStyledCard(page);
      await expectHydratedCounter(page);
      // Covers React's minified hydration errors (#418, #423, #425): they arrive as page errors.
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });

  describe('under next dev', () => {
    let server: Awaited<ReturnType<typeof serveApp>> | undefined;

    beforeAll(async () => {
      const port = await freePort();
      server = await serveApp(served().app, ['pnpm', 'exec', 'next', 'dev', '--port', String(port)], port);
    });

    afterAll(async () => {
      await server?.close();
    });

    // Dev React prints the full hydration warning texts.
    it('hydrates with no hydration warning and counts a click', async () => {
      const {page, messages, close} = await openPage(server!.url);
      try {
        await expectStyledCard(page);
        await expectHydratedCounter(page);
        expect(consoleProblems(messages)).toEqual([]);
      } finally {
        await close();
      }
    });
  });
});
