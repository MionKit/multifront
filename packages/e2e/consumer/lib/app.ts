import {execFile, spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, delimiter, join, relative, isAbsolute} from 'node:path';
import type {Target} from '@multifront/core';
import type {Page} from 'playwright';
import type {Manifest} from 'vite';
import {afterAll, beforeAll, expect} from 'vitest';
import {FIXTURES_DIR, LIBRARY_DIR} from '../../fixtures/index.ts';
import {collectConsole, computed, consoleProblems, launchChromium} from '../../browser/lib/chromium.ts';
import {styles} from '../../browser/lib/parity.ts';
import {scopeAttribute} from '../../browser/lib/scope.ts';
import {fixtureTarballs} from './pack.ts';
import type {ToolRun} from './pack.ts';

export const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');

// The repo's install policy, minus its package list and `frozenLockfile`: a fresh app has no lockfile.
const INSTALL_POLICY = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8').replace(
  /^packages:\n(?: {2}- .*\n)+|^frozenLockfile: .*\n/gm,
  ''
);

export type Command = [string, ...string[]];

export interface ConsumerApp {
  dir: string;
  remove: () => Promise<void>;
}

function insideRepo(path: string): boolean {
  const rel = relative(REPO_ROOT, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// User's shell env: Vitest's NODE_ENV=test makes Vite build dev React; repo bins must not stand in for the app's.
function consumerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name === 'NODE_ENV' || name === 'NODE_PATH' || name === 'TEST') continue;
    if (/^(VITEST|npm_package_|npm_lifecycle_)/.test(name)) continue;
    env[name] = value;
  }
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  if (pathKey)
    env[pathKey] = env[pathKey]!.split(delimiter)
      .filter((entry) => entry && !insideRepo(entry))
      .join(delimiter);
  // Next.js telemetry is opt-out.
  env.NEXT_TELEMETRY_DISABLED = '1';
  return env;
}

/** Never throws on a non-zero exit: the code and the output say what happened. */
export function runInApp(app: ConsumerApp, [file, ...args]: Command): Promise<ToolRun> {
  return new Promise((resolve) => {
    execFile(file, args, {cwd: app.dir, env: consumerEnv(), maxBuffer: 64 * 1024 * 1024}, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (!err) return resolve({code: 0, output});
      const {code, signal} = err;
      resolve({
        code: typeof code === 'number' ? code : 1,
        output: signal ? `${output}\nkilled by ${signal}` : output || String(err),
      });
    });
  });
}

/** A `fixtures/apps/<template>` copy outside the workspace, tarballs installed. */
export async function createConsumerApp(template: string, tarballs: string[]): Promise<ConsumerApp> {
  const dir = await mkdtemp(join(tmpdir(), `mf-consumer-${template}-`));
  const app: ConsumerApp = {
    dir,
    async remove() {
      if (process.env.MULTIFRONT_KEEP_CONSUMER_APPS) return void process.stderr.write(`kept consumer app: ${dir}\n`);
      await rm(dir, {recursive: true, force: true});
    },
  };
  try {
    const skip = new Set(['node_modules', 'dist']);
    await cp(join(FIXTURES_DIR, 'apps', template), dir, {recursive: true, filter: (source) => !skip.has(basename(source))});
    await writeFile(join(dir, 'pnpm-workspace.yaml'), INSTALL_POLICY);
    const commands: Command[] = [['pnpm', 'install']];
    if (tarballs.length > 0) commands.push(['pnpm', 'add', ...tarballs]);
    for (const command of commands) {
      const {code, output} = await runInApp(app, command);
      if (code !== 0) throw new Error(`${command.join(' ')} failed in ${template}:\n${output}`);
    }
  } catch (err) {
    await app.remove();
    throw err;
  }
  return app;
}

// Install runs no `prepare`: sync writes `.svelte-kit/tsconfig.json`, which the app's tsconfig extends.
export async function svelteCheck(app: ConsumerApp): Promise<ToolRun> {
  const sync = await runInApp(app, ['pnpm', 'exec', 'svelte-kit', 'sync']);
  if (sync.code !== 0) throw new Error(`svelte-kit sync failed:\n${sync.output}`);
  return runInApp(app, [
    'pnpm',
    'exec',
    'svelte-check',
    '--tsconfig',
    './tsconfig.json',
    '--fail-on-warnings',
    '--output',
    'machine',
  ]);
}

export function readDist(app: ConsumerApp, file: string): string {
  return readFileSync(join(app.dir, 'dist', file), 'utf8');
}

/** Every JS and CSS file one manifest entry loads, its static imports included. */
export function manifestGraph(app: ConsumerApp, entry: string): {js: string[]; css: string[]} {
  const manifest = JSON.parse(readDist(app, '.vite/manifest.json')) as Manifest;
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

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const {port} = server.address() as {port: number};
      server.close(() => resolve(port));
    });
  });
}

const READY_TIMEOUT = 30_000;
const CLOSE_TIMEOUT = 10_000;

/** `command` must listen on `port`; resolves once the page answers. */
export async function serveApp(app: ConsumerApp, command: Command, port: number) {
  const [file, ...args] = command;
  // Own process group: `pnpm exec` leaves the server as a grandchild, so close() kills the group.
  const child = spawn(file, args, {cwd: app.dir, env: consumerEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let running = true;
  const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // Already gone.
    }
  };
  // At most CLOSE_TIMEOUT: a zombie no init reaps keeps a group alive.
  const groupGone = async () => {
    for (const deadline = Date.now() + CLOSE_TIMEOUT; Date.now() < deadline;) {
      try {
        process.kill(-child.pid!, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  // A detached group outlives its parent: an interrupted run must not leave the server listening.
  const onExit = () => kill();
  process.once('exit', onExit);
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      running = false;
      process.off('exit', onExit);
      resolve();
    })
  );
  const close = async () => {
    if (!running) return;
    kill();
    await exited;
    // `pnpm exec` exits before the server it started, which still writes to the app (`.next/dev`) while it stops.
    if (await groupGone()) return;
    kill('SIGKILL');
    await groupGone();
  };
  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + READY_TIMEOUT;
  while (true) {
    if (!running) throw new Error(`${command.join(' ')} exited before serving ${url}:\n${output}`);
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await close();
      throw new Error(`${command.join(' ')} did not serve ${url} within ${READY_TIMEOUT / 1000} s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {url, output: () => output, close};
}

interface ConsumerPage {
  page: Page;
  // Live: console messages, page errors and CSP violations, as they come.
  messages: ReturnType<typeof collectConsole>;
  close: () => Promise<void>;
}

// Runs in the page, so a CSP violation reaches `messages` as a console error.
const CSP_REPORTER = `document.addEventListener('securitypolicyviolation', (event) => {
  console.error('CSP violation: ' + event.violatedDirective + ' ' + event.blockedURI);
});`;

export async function openPage(url: string, javaScript = true): Promise<ConsumerPage> {
  const browser = await launchChromium();
  try {
    const page = await (await browser.newContext({javaScriptEnabled: javaScript})).newPage();
    const messages = collectConsole(page);
    await page.addInitScript({content: CSP_REPORTER});
    await page.goto(url);
    return {page, messages, close: () => browser.close()};
  } catch (err) {
    await browser.close();
    throw err;
  }
}

export interface ServedApp {
  app: ConsumerApp;
  // The installed one.
  tarball: string;
  url: string;
  // The build command's output.
  build: string;
}

export interface ServedAppOptions {
  target: Target;
  template: string;
  build: Command;
  serve: (port: number) => Command;
  // Default: the fixture library's.
  tarballs?: () => ReturnType<typeof fixtureTarballs>;
  // Runs on the installed app before its build.
  prepare?: (app: ConsumerApp) => Promise<void>;
  // Of the setup and of the cleanup that waits for it.
  timeout?: number;
}

/** Registers the spec's beforeAll and afterAll hooks. */
export function serveConsumerApp(options: ServedAppOptions): () => ServedApp {
  const {target, template, build, serve, tarballs = fixtureTarballs, prepare, timeout = 240_000} = options;
  let packed: Awaited<ReturnType<typeof fixtureTarballs>> | undefined;
  let app: ConsumerApp | undefined;
  let server: Awaited<ReturnType<typeof serveApp>> | undefined;
  let built = '';
  let tarball = '';
  let setup: Promise<void> | undefined;
  beforeAll(() => {
    setup = (async () => {
      packed = await tarballs();
      tarball = packed.tarballs[target] ?? '';
      if (!tarball) throw new Error(`no ${target} tarball among ${JSON.stringify(packed.tarballs)}`);
      app = await createConsumerApp(template, [tarball]);
      await prepare?.(app);
      const result = await runInApp(app, build);
      if (result.code !== 0) throw new Error(`${build.join(' ')} failed in ${template}:\n${result.output}`);
      built = result.output;
      const port = await freePort();
      server = await serveApp(app, serve(port), port);
    })();
    return setup;
  }, timeout);
  afterAll(async () => {
    // A timed-out setup keeps running: what it creates late must be removed too.
    await setup?.catch(() => {});
    await server?.close();
    await app?.remove();
    await packed?.remove();
  }, timeout);
  return () => {
    if (!app || !server) throw new Error(`${template} is not served: its setup failed`);
    return {app, tarball, url: server.url, build: built};
  };
}

/** Card as the library CSS styles it, with the scope attribute every target stamps. */
export async function expectStyledCard(page: Page): Promise<void> {
  const card = page.locator('article.card');
  await card.waitFor();
  expect(await computed(card, 'padding')).toBe('16px');
  expect(await computed(card, 'color')).toBe('rgb(30, 60, 90)');
  expect(await computed(card.locator('h2'), 'color')).toBe('rgb(150, 40, 60)');
  expect(await card.getAttribute(scopeAttribute(LIBRARY_DIR, join(LIBRARY_DIR, 'src', 'Card.ucf'), true))).toBe('');
}

// Styles every framework's package gives its elements; no Button color: the React page sets it.
export const KEY_STYLES: Record<string, Record<string, string>> = {
  'article.card': {padding: '16px', color: 'rgb(30, 60, 90)', 'border-radius': '8px', 'font-size': '16px'},
  'article.card h2': {padding: '0px 0px 8px', color: 'rgb(150, 40, 60)', 'border-radius': '2px', 'font-size': '20px'},
  'button.counter': {padding: '4px 12px', color: 'rgb(120, 40, 160)'},
  'button:has-text("Go")': {padding: '4px 12px', 'background-color': 'rgb(90, 50, 160)', 'font-weight': '600'},
};

export async function keyStyles(page: Page): Promise<typeof KEY_STYLES> {
  const read: typeof KEY_STYLES = {};
  for (const [selector, properties] of Object.entries(KEY_STYLES))
    read[selector] = await styles(page.locator(selector), Object.keys(properties));
  return read;
}

/** Server-rendered apps set `body[data-hydrated]` once hydrated; `more` checks the page further. */
export async function expectHydrates(
  url: string,
  counterSelector: string,
  more?: (page: Page) => Promise<void>,
  {hydrates = true}: {hydrates?: boolean} = {}
): Promise<void> {
  const {page, messages, close} = await openPage(url);
  try {
    await expectStyledCard(page);
    if (hydrates) await page.locator('body[data-hydrated]').waitFor({state: 'attached'});
    const counter = page.locator(counterSelector);
    expect(await counter.textContent()).toBe('Count 0');
    await counter.click();
    await expect.poll(() => counter.textContent()).toBe('Count 1');
    await more?.(page);
    expect(consoleProblems(messages)).toEqual([]);
  } finally {
    await close();
  }
}

/** Proves the CSP holds and its violations get reported. */
export async function expectCspEnforced(url: string): Promise<void> {
  const {page, messages, close} = await openPage(url);
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
}
