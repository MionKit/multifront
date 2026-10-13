import {execFile, spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, delimiter, join, relative, isAbsolute} from 'node:path';
import type {Page} from 'playwright';
import type {Manifest} from 'vite';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import {collectConsole, launchChromium} from '../../browser/lib/chromium.ts';
import type {ToolRun} from './pack.ts';

export const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');

// The repo's install policy, minus its package list and `frozenLockfile`: a fresh app has no lockfile.
const INSTALL_POLICY = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8').replace(
  /^packages:\n(?: {2}- .*\n)+|^frozenLockfile: .*\n/gm,
  ''
);

type Command = [string, ...string[]];

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

/** A file of the app's `vite build` output. */
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

/** `command` must listen on `port`; resolves once the page answers. */
export async function serveApp(app: ConsumerApp, command: Command, port: number) {
  const [file, ...args] = command;
  // Own process group: `pnpm exec` leaves the server as a grandchild, so close() kills the group.
  const child = spawn(file, args, {cwd: app.dir, env: consumerEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let running = true;
  const kill = () => {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  // A detached group outlives its parent: an interrupted run must not leave the server listening.
  process.once('exit', kill);
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      running = false;
      process.off('exit', kill);
      resolve();
    })
  );
  const close = async () => {
    if (!running) return;
    kill();
    await exited;
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

export async function openPage(url: string): Promise<ConsumerPage> {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const messages = collectConsole(page);
    await page.addInitScript({content: CSP_REPORTER});
    await page.goto(url);
    return {page, messages, close: () => browser.close()};
  } catch (err) {
    await browser.close();
    throw err;
  }
}
