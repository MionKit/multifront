// Milestone 4's exit test: Counter.ucf as Vue through real Vite, plugin-vue, Chromium and tsserver with Vue's plugin.
import {readFileSync, writeFileSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Browser} from 'playwright';
import {preview} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, copyApp, removeApp} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER} from '../build/lib/build.ts';
import {execNode, startViteCli} from '../build/lib/freshProcess.ts';
import {edit as editOpen, PLUGIN} from '../editor/lib/cases.ts';
import {E2E_DIR, locate, open, startTsserver, VUE_PLUGIN, VUE_PLUGIN_DIR} from '../editor/lib/tsserver.ts';
import type {Component} from '../editor/lib/tsserver.ts';
import {collectConsole, computed, launchChromium} from './lib/chromium.ts';
import {expectSameComputedStyles} from './lib/parity.ts';
import {editFile, trackHmrPayloads, trackRequests} from './lib/requests.ts';
import {scopeAttribute} from './lib/scope.ts';
import {buildAndPreview, localUrl} from './lib/serve.ts';

const DEMO = join(FIXTURES_DIR, 'apps', 'demo');
const COUNTERS = {react: '#app [data-demo="counter"] > .counter', vue: '#vue > .counter'};
const PROPERTIES = ['padding', 'color', 'font-size', 'border'];
// Counter's root, its title and its button.
const PARTS = ['', ' .label', ' button'];
const POLL = {timeout: 10_000};

const problems = (messages: ReturnType<typeof collectConsole>) =>
  messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror');

/** Rewrites a copy's file; a needle that is gone fails here, not as a test of the file unchanged. */
async function replaceIn(file: string, pairs: [needle: string, text: string][]): Promise<void> {
  let source = await readFile(file, 'utf8');
  for (const [needle, text] of pairs) {
    if (!source.includes(needle)) throw new Error(`no ${needle} in ${file}`);
    source = source.replace(needle, text);
  }
  await writeFile(file, source);
}

/** A `copyApp('vue')` copy; Vite puts its dep cache beside the nearest package.json, removed with the copy. */
async function vueCopy(): Promise<{root: string; counter: string}> {
  const root = await copyApp('vue');
  try {
    await writeFile(join(root, 'package.json'), '{"type": "module"}\n');
  } catch (err) {
    await removeApp(root);
    throw err;
  }
  return {root, counter: resolve(root, '..', '..', 'components', 'Counter.ucf')};
}

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

describe('milestone 4 exit test', () => {
  it('1. a production build of the demo renders Counter.ucf as React and as Vue, same data-v-*, same styles', async () => {
    const page = await browser!.newPage();
    const app = await buildAndPreview(DEMO);
    try {
      const messages = collectConsole(page);
      await page.goto(app.url);
      await page.locator(`${COUNTERS.react} button`).waitFor();
      await page.locator(`${COUNTERS.vue} button`).waitFor();

      const scope = scopeAttribute(DEMO, componentPath('Counter.ucf'), true);
      expect(await page.locator(COUNTERS.react).getAttribute(scope)).toBe('');
      expect(await page.locator(COUNTERS.vue).getAttribute(scope)).toBe('');
      // Hand-read from Counter.ucf: two unstyled elements would match each other too.
      expect(await computed(page.locator(COUNTERS.vue), 'color')).toBe('rgb(120, 40, 160)');
      expect(await computed(page.locator(`${COUNTERS.vue} button`), 'padding')).toBe('4px 12px');
      for (const part of PARTS) {
        await expectSameComputedStyles(page.locator(COUNTERS.react + part), page.locator(COUNTERS.vue + part), PROPERTIES);
      }
      await page.waitForLoadState('networkidle');
      expect(problems(messages)).toEqual([]);
    } finally {
      await page.close();
      await app.close();
    }
  });

  it('2. the Vue app’s SSR build renders the Counter on the server and hydrates with no mismatch warning', async () => {
    const page = await browser!.newPage();
    const {root, counter} = await vueCopy();
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    try {
      // So `vite build` takes the hydrating entry and keeps the outlet.
      await replaceIn(join(root, 'index.html'), [
        ['<div id="app"></div>', '<div id="app"><!--app-html--></div>'],
        ['/src/main.ts', '/src/entry-client.ts'],
      ]);
      // Production Vue skips class, style and attribute mismatch checks unless this flag is on.
      await replaceIn(join(root, 'vite.config.ts'), [['vue()', 'vue({features: {prodHydrationMismatchDetails: true}})']]);
      // Two processes, as an app's build script runs them.
      for (const args of [
        ['build', '--outDir', 'dist/client'],
        ['build', '--ssr', 'src/entry-server.ts', '--outDir', 'dist/server'],
      ]) {
        await startViteCli(root, args, {NODE_ENV: 'production'}).finished();
      }
      const entry = pathToFileURL(join(root, 'dist', 'server', 'entry-server.js')).href;
      const {stdout: rendered} = await execNode(process.execPath, [
        '--input-type=module',
        '-e',
        `const {render} = await import(${JSON.stringify(entry)}); process.stdout.write(await render());`,
      ]);
      const htmlFile = join(root, 'dist', 'client', 'index.html');
      const template = readFileSync(htmlFile, 'utf8');
      expect(template).toContain('<!--app-html-->');
      writeFileSync(htmlFile, template.replace('<!--app-html-->', rendered));

      server = await preview({
        root,
        configLoader: APP_CONFIG_LOADER,
        logLevel: 'silent',
        build: {outDir: 'dist/client'},
        preview: {port: 0},
      });
      const messages = collectConsole(page);
      const response = await page.goto(localUrl(server.resolvedUrls, root));
      const html = await response!.text();
      // Server-rendered with the production scope id: the markup is in the page before any script runs.
      expect(html).toContain(`<div class="counter" ${scopeAttribute(root, counter, true)}>`);
      expect(html).toMatch(/<button [^>]*>2<\/button>/);

      await expect.poll(() => page.locator('#app').evaluate((element) => '__vue_app__' in element), POLL).toBe(true);
      // `createApp()` would mount over the markup and set it; `createSSRApp()` hydrates and does not.
      expect(await page.locator('#app').getAttribute('data-v-app')).toBeNull();
      expect(await computed(page.locator('.counter'), 'color')).toBe('rgb(120, 40, 160)');
      const button = page.locator('.counter button');
      await button.click();
      await expect.poll(() => button.textContent()).toBe('3');
      // A mismatch is a `[Vue warn]` warning plus a console error.
      expect(problems(messages)).toEqual([]);
    } finally {
      await page.close();
      await server?.close();
      await removeApp(root);
    }
  });

  it('3. a fresh dev server answers the Vue style sub-request first, then a <template> edit keeps the count', async () => {
    const page = await browser!.newPage();
    const {root, counter} = await vueCopy();
    const vite = startViteCli(root, ['--port', '0'], {NODE_ENV: 'development'});
    try {
      const url = /Local:\s+(\S+)/.exec(await vite.waitForOutput(/Local:\s+http\S+/))![1]!;
      const scope = scopeAttribute(root, counter, false);
      const styleUrl = `/@fs${counter}?vue&type=style&index=0&scoped=${scope.slice('data-v-'.length)}&lang.css`;
      const response = await fetch(new URL(styleUrl, url));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain(`.counter[${scope}]`);
      expect(body).toContain('rgb(120, 40, 160)');

      const messages = collectConsole(page);
      let loads = 0;
      page.on('load', () => void loads++);
      const requests = trackRequests(page);
      const payloads = trackHmrPayloads(page);
      await page.goto(url);
      const count = () => page.locator('.counter button').textContent();
      await expect.poll(count, POLL).toBe('2');
      await page.locator('.counter button').click();
      await expect.poll(count).toBe('3');
      await requests.quiet(500);

      payloads.clear();
      await editFile(requests, counter, '<span class="label">Clicks</span>', '<span class="label">Hits</span>');
      await expect.poll(() => page.locator('.counter .label').textContent(), POLL).toBe('Hits');
      await requests.quiet(500);
      expect(await count()).toBe('3');
      // One Vue update of the main module; its URL has no `/@fs` when the warm-up created the module first.
      expect(payloads.updatedPaths().map((path) => path.replace(/^\/@fs/, ''))).toEqual([counter]);
      expect(payloads.fullReloads()).toBe(0);
      expect(loads).toBe(1);
      expect(problems(messages)).toEqual([]);
      // Its `hmr update` line holds the copy's path, which may itself spell "error".
      expect(vite.output().replaceAll(resolve(root, '..', '..'), '')).not.toMatch(/error/i);
    } finally {
      await page.close();
      await vite.stop();
      await removeApp(root);
    }
  });

  it("4. tsserver with Vue's plugin and ours reports the wrong prop type on <Counter> in App.vue", async () => {
    const root = join(FIXTURES_DIR, 'apps', 'vue');
    const filename = join(root, 'src', 'App.vue');
    const app: Component = {filename, source: await readFile(filename, 'utf8')};
    const server = startTsserver({cwd: root, plugins: [VUE_PLUGIN, PLUGIN], probeLocations: [E2E_DIR, VUE_PLUGIN_DIR]});
    try {
      await open(server, [app]);
      expect(await server.diagnostics(filename)).toEqual([]);
      const [needle, newText] = [':start="2"', `:start="'x'"`];
      await editOpen(server, app, needle, newText);
      const source = app.source.replace(needle, newText);
      const diagnostics = await server.diagnostics(filename);
      expect(diagnostics.map(({code, start, end}) => ({code, start, end}))).toEqual([
        {code: 2322, start: locate(source, ':start', 1), end: locate(source, ':start', ':start'.length)},
      ]);
    } finally {
      await server.stop();
    }
  });
});
