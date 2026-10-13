import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Manifest} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {createConsumerApp, freePort, openPage, runInApp, serveApp} from './lib/app.ts';
import type {ConsumerApp} from './lib/app.ts';
import {fixtureTarballs} from './lib/pack.ts';

type Served = Awaited<ReturnType<typeof serveApp>>;

let packed: Awaited<ReturnType<typeof fixtureTarballs>> | undefined;
let app: ConsumerApp | undefined;
let server: Served | undefined;
let build = '';
let setup: Promise<void> | undefined;

beforeAll(() => {
  setup = (async () => {
    packed = await fixtureTarballs();
    const tarball = packed.tarballs.react;
    if (!tarball) throw new Error(`no react tarball among ${JSON.stringify(packed.tarballs)}`);
    app = await createConsumerApp('consumer-vite-react', [tarball]);
    const built = await runInApp(app, ['pnpm', 'exec', 'vite', 'build', '--sourcemap', '--manifest']);
    build = built.output;
    if (built.code !== 0) throw new Error(`vite build failed:\n${built.output}`);
    const port = await freePort();
    server = await serveApp(app, ['pnpm', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort'], port);
  })();
  return setup;
}, 240_000);

afterAll(async () => {
  // A timed-out setup keeps running: wait for it, so what it creates late is removed too.
  await setup?.catch(() => {});
  await server?.close();
  await app?.remove();
  await packed?.remove();
});

function readDist(file: string): string {
  return readFileSync(join(app!.dir, 'dist', file), 'utf8');
}

/** Every JS and CSS file one manifest entry loads, its static imports included. */
function graphOf(entry: string): {js: string[]; css: string[]} {
  const manifest = JSON.parse(readDist('.vite/manifest.json')) as Manifest;
  const js = new Set<string>();
  const css = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk) throw new Error(`no ${key} in the manifest`);
    if (js.has(chunk.file)) return;
    js.add(chunk.file);
    for (const file of chunk.css ?? []) css.add(file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entry);
  return {js: [...js], css: [...css]};
}

/** The modules bundled into a graph, read from its source maps. */
function sourcesOf(js: string[]): string[] {
  return js.flatMap((file) => (JSON.parse(readDist(`${file}.map`)) as {sources: string[]}).sources);
}

const PACKAGE = '/node_modules/@mf-fixture/ui-react/';
const COUNTER_MODULES = /\/node_modules\/@mf-fixture\/ui-react\/(Counter|hooks\/useToggle)\.js$/;

describe('the packed React package in a fresh Vite React app', () => {
  it('installs the tarball and no multifront package', () => {
    const installed = readdirSync(join(app!.dir, 'node_modules', '.pnpm'));
    expect(installed.some((name) => name.startsWith('@mf-fixture+ui-react@'))).toBe(true);
    expect(installed.filter((name) => name.startsWith('@multifront+'))).toEqual([]);
  });

  it('type checks with real tsc: the one wrong prop is the expected error', async () => {
    const {code, output} = await runInApp(app!, ['pnpm', 'exec', 'tsc', '--noEmit', '--pretty', 'false']);
    expect(output.trim(), output).toBe('');
    expect(code).toBe(0);
  });

  it('builds with real vite build, on production React', () => {
    expect(build).toContain('built in');
    const sources = sourcesOf(graphOf('index.html').js);
    expect(sources.filter((source) => source.endsWith('.development.js'))).toEqual([]);
    expect(sources.some((source) => source.endsWith('.production.js'))).toBe(true);
  });

  it('renders Card, Counter and Button with the library CSS, no console problem and no CSP violation', async () => {
    const {page, messages, close} = await openPage(server!.url);
    try {
      const card = page.locator('article.card');
      await card.waitFor();
      expect(await computed(card, 'padding')).toBe('16px');
      expect(await computed(card, 'color')).toBe('rgb(30, 60, 90)');
      expect(await computed(card.locator('h2'), 'color')).toBe('rgb(150, 40, 60)');

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

  it('only-card bundles Card and its CSS, never Counter code or CSS (sideEffects)', () => {
    const onlyCard = graphOf('src/only-card.tsx');
    const onlyCardSources = sourcesOf(onlyCard.js);
    expect(onlyCardSources.some((source) => source.endsWith(`${PACKAGE}Card.js`))).toBe(true);
    expect(onlyCardSources.filter((source) => COUNTER_MODULES.test(source))).toEqual([]);
    const onlyCardCss = onlyCard.css.map(readDist).join('\n');
    expect(onlyCardCss).toContain('--card-padding');
    expect(onlyCardCss).not.toContain('.counter');

    const main = graphOf('index.html');
    expect(sourcesOf(main.js).filter((source) => COUNTER_MODULES.test(source))).toHaveLength(2);
    expect(main.css.map(readDist).join('\n')).toContain('.counter');
  });
});
