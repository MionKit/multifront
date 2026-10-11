import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {rootRelativePath, scopeId} from '@multifront/core';
import {beforeEach, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {runFreshDevServer, startViteCli} from './lib/freshProcess.ts';

// plugin-vue's descriptor cache lives at its module level: each case runs in a process of its own, so it starts empty.
const counter = readComponent('Counter.ucf').source;
const OLD_COLOR = 'rgb(120, 40, 160)';

let root: string;
let file: string;

beforeEach(async () => {
  root = await copyApp('vue');
  file = resolve(root, '..', '..', 'components', 'Counter.ucf');
  return () => removeApp(root);
});

const devId = () => scopeId(rootRelativePath(root, file), counter, false);
// The URL a page open before a restart holds.
const styleUrl = () => `/@fs${file}?vue&type=style&index=0&scoped=${devId()}&lang.css`;

function cssOf(module: string): string {
  return JSON.parse(/const __vite__css = ("(?:[^"\\]|\\.)*")/.exec(module)![1]!) as string;
}

describe('a .ucf sub-request plugin-vue has no descriptor for', () => {
  it('is the first request to a fresh dev server and returns the scoped CSS', async () => {
    const vite = startViteCli(root, ['--port', '0'], {NODE_ENV: 'development'});
    try {
      const url = /Local:\s+(\S+)/.exec(await vite.waitForOutput(/Local:\s+http\S+/))![1]!;
      const response = await fetch(new URL(styleUrl(), url));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const css = cssOf(body);
      expect(css).toContain(`.counter[data-v-${devId()}]`);
      expect(css).toContain(OLD_COLOR);
      expect(vite.output()).not.toMatch(/error/i);
    } finally {
      await vite.stop();
    }
  });

  it('is the first SSR request of a fresh process', async () => {
    const [code] = await runFreshDevServer(root, [{env: 'ssr', request: styleUrl()}]);
    // SSR answers a style that is not inline with an empty module.
    expect(code).toBe('');
  });

  it('serves the new CSS after an in-process restart, when Counter.ucf changed on disk', async () => {
    const newColor = 'rgb(10, 20, 30)';
    // No watcher: plugin-vue's hot update must not refresh its cache before the restart.
    const [, before, after] = await runFreshDevServer(
      root,
      [
        {env: 'client', request: `/@fs${file}`},
        {env: 'client', request: styleUrl()},
        {edit: {file, from: OLD_COLOR, to: newColor}},
        {restart: true},
        {env: 'client', request: styleUrl()},
      ],
      {watch: false}
    );
    expect(cssOf(before!)).toContain(OLD_COLOR);
    expect(cssOf(after!)).toContain(newColor);
    expect(cssOf(after!)).not.toContain(OLD_COLOR);
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
    const vite = startViteCli(root, ['build', '--watch', '--minify', 'false'], {NODE_ENV: 'production'});
    try {
      await vite.waitForOutput(/built in \d+/);
      expect(await read('.css')).toContain(`.counter[data-v-${idOf(counter)}]`);
      await writeFile(file, edited);
      await vite.waitForOutput(/built in \d+/, 2);
      expect(vite.output()).not.toMatch(/error/i);
      expect(idOf(edited)).not.toBe(idOf(counter));
      expect(await read('.css')).toContain(`.counter[data-v-${idOf(edited)}]`);
      expect(await read('.js')).toContain(`data-v-${idOf(edited)}`);
    } finally {
      await vite.stop();
    }
  });
});
