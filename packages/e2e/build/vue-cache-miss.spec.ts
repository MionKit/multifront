import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {rootRelativePath, scopeId} from '@multifront/core';
import type {Plugin} from 'vite';
import {beforeEach, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp, saveFile} from '../fixtures/index.ts';
import {hotUpdatesOf, withDevServer} from './lib/build.ts';
import {runFreshDevServer, startViteCli, STOP_GRACE_MS} from './lib/freshProcess.ts';

const counter = readComponent('Counter.front').source;
const OLD_COLOR = 'rgb(120, 40, 160)';

let root: string;
let file: string;
let running: ReturnType<typeof startViteCli>[] = [];

beforeEach(async () => {
  root = await copyApp('vue');
  file = resolve(root, '..', '..', 'components', 'Counter.front');
  // The CLI puts its dep cache beside the nearest package.json: this one is removed with the copy.
  await writeFile(join(root, 'package.json'), '{"type": "module"}\n');
  return async () => {
    // Stopped here, not in onTestFinished: that runs after this cleanup, on a removed copy.
    await Promise.all(running.map((vite) => vite.stop()));
    running = [];
    await removeApp(root);
  };
});

const devId = () => scopeId(rootRelativePath(root, file), counter, false);
// The URL a page open before a restart holds.
const styleUrl = (index = 0) =>
  index === 0
    ? `/@fs${file}?vue&type=style&index=0&scoped=${devId()}&lang.css`
    : `/@fs${file}?vue&type=style&index=${index}&lang.module.css`;

function cssOf(module: string): string {
  return JSON.parse(/const __vite__css = ("(?:[^"\\]|\\.)*")/.exec(module)![1]!) as string;
}

function cli(args: string[], env: NodeJS.ProcessEnv) {
  const vite = startViteCli(root, args, env);
  running.push(vite);
  return vite;
}

// plugin-vue's descriptor cache is module level: each case gets its own process so the cache starts empty.
describe('a .front sub-request plugin-vue has no descriptor for', () => {
  it('is the first request to a fresh dev server and returns the scoped CSS', async () => {
    const vite = cli(['--port', '0'], {NODE_ENV: 'development'});
    const url = /Local:\s+(\S+)/.exec(await vite.waitForOutput(/Local:\s+http\S+/))![1]!;
    const response = await fetch(new URL(styleUrl(), url));
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const css = cssOf(body);
    expect(css).toContain(`.counter[data-v-${devId()}]`);
    expect(css).toContain(OLD_COLOR);
    expect(vite.output()).not.toMatch(/error/i);
  });

  it('is the first SSR request of a fresh process', async () => {
    const [code] = await runFreshDevServer(root, [{env: 'ssr', request: styleUrl()}]);
    // SSR answers a style that is not inline with an empty module.
    expect(code).toBe('');
  });

  it('serves the new CSS after an in-process restart, when Counter.front changed on disk', async () => {
    const newColor = 'rgb(10, 20, 30)';
    const [, before, after] = await runFreshDevServer(root, [
      {env: 'client', request: `/@fs${file}`},
      {env: 'client', request: styleUrl()},
      {edit: {file, from: OLD_COLOR, to: newColor}},
      {restart: true},
      {env: 'client', request: styleUrl()},
    ]);
    expect(cssOf(before!)).toContain(OLD_COLOR);
    expect(cssOf(after!)).toContain(newColor);
    expect(cssOf(after!)).not.toContain(OLD_COLOR);
  });
});

// Each test's copy is a new path: neither our record nor plugin-vue's cache knows it yet.
describe('the warm-up', () => {
  function transformsOf(target: string): {plugin: Plugin; count: () => number} {
    let count = 0;
    const plugin: Plugin = {
      name: 'count-transforms',
      transform(_code, id) {
        if (id === target) count++;
      },
    };
    return {plugin, count: () => count};
  }

  it('transforms Counter.front once when its sub-requests follow the module', async () => {
    const transforms = transformsOf(file);
    await withDevServer(root, {plugins: [transforms.plugin]}, async (server) => {
      await server.environments.client.transformRequest(`/@fs${file}`);
      await server.environments.client.transformRequest(styleUrl(0));
      await server.environments.client.transformRequest(styleUrl(1));
    });
    expect(transforms.count()).toBe(1);
  });

  it('transforms Counter.front once for sub-requests that come first and together', async () => {
    const transforms = transformsOf(file);
    const codes = await withDevServer(root, {plugins: [transforms.plugin]}, (server) =>
      Promise.all([0, 1].map((index) => server.environments.client.transformRequest(styleUrl(index))))
    );
    expect(cssOf(codes[0]!.code)).toContain(OLD_COLOR);
    expect(transforms.count()).toBe(1);
  });

  it('has nothing to do for the style sub-request of a <style> hot update', async () => {
    const newColor = 'rgb(10, 20, 30)';
    const transforms = transformsOf(file);
    const hot = hotUpdatesOf(file);
    const after = await withDevServer(root, {plugins: [transforms.plugin, hot.plugin]}, async (server) => {
      await server.environments.client.transformRequest(`/@fs${file}`);
      await server.environments.client.transformRequest(styleUrl(0));
      const updated = hot.next();
      await saveFile(file, counter.replace(OLD_COLOR, newColor));
      await updated;
      return server.environments.client.transformRequest(styleUrl(0));
    });
    expect(cssOf(after!.code)).toContain(newColor);
    expect(transforms.count()).toBe(1);
  });
});

describe('vite build --watch', () => {
  it('rebuilds after a <react> block edit, with the new scope id in the CSS and the JS', async () => {
    const edited = counter.replace('className="label">Clicks', 'className="label">Clicks so far');
    expect(edited).not.toBe(counter);
    const idOf = (source: string) => scopeId(rootRelativePath(root, file), source, true);
    const assets = join(root, 'dist', 'assets');
    const read = async (extension: string) => {
      const name = (await readdir(assets)).find((entry) => entry.endsWith(extension))!;
      return readFile(join(assets, name), 'utf8');
    };
    const vite = cli(['build', '--watch', '--minify', 'false'], {NODE_ENV: 'production'});
    await vite.waitForOutput(/built in \d+/);
    expect(await read('.css')).toContain(`.counter[data-v-${idOf(counter)}]`);
    await saveFile(file, edited);
    await vite.waitForOutput(/built in \d+/, 2);
    expect(vite.output()).not.toMatch(/error/i);
    expect(idOf(edited)).not.toBe(idOf(counter));
    expect(await read('.css')).toContain(`.counter[data-v-${idOf(edited)}]`);
    expect(await read('.js')).toContain(`data-v-${idOf(edited)}`);
  });
});

describe('the vite CLI started by startViteCli()', () => {
  it('fails a wait for output it never prints with the pattern and the output so far', async () => {
    const vite = cli(['--port', '0'], {NODE_ENV: 'development'});
    await vite.waitForOutput(/Local:/);
    await expect(vite.waitForOutput(/never printed/, 1, 1000)).rejects.toThrow(
      /^no 1 × \/never printed\/ after 1000 ms:\n[^]*Local:/
    );
  });

  it('stops even when its server.close() never settles', async () => {
    // The interval keeps Node alive: a bare pending promise would let it exit.
    await writeFile(
      join(root, 'vite.config.ts'),
      `import vue from '@vitejs/plugin-vue';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [vue(), multifront(), {name: 'never-closes', closeBundle: () => new Promise(() => setInterval(() => {}, 1000))}]});
`
    );
    const vite = cli(['--port', '0'], {NODE_ENV: 'development'});
    await vite.waitForOutput(/Local:/);
    const start = Date.now();
    await vite.stop();
    // Slack for timer and clock rounding; at least the grace period shows the polite stop really stalled.
    expect(Date.now() - start).toBeGreaterThanOrEqual(STOP_GRACE_MS - 250);
    expect(Date.now() - start).toBeLessThan(STOP_GRACE_MS + 10_000);
  });
});
