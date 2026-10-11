import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {beforeEach, describe, expect, it, onTestFinished} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {scopeAttribute} from '../browser/lib/scope.ts';
import {exportedScopeId} from './lib/build.ts';
import {execNode, startSsrServer, startViteCli} from './lib/freshProcess.ts';
import {moduleReferences} from './lib/references.ts';

let root: string;
let file: string;

beforeEach(async () => {
  root = await copyApp('vue');
  file = resolve(root, '..', '..', 'components', 'Counter.ucf');
  // Vite puts its dep cache beside the nearest package.json: this one is removed with the copy.
  await writeFile(join(root, 'package.json'), '{"type": "module"}\n');
  return () => removeApp(root);
});

/** The `data-v-*` and `$style.button` class of Counter's rendered markup. */
function renderedCounter(html: string) {
  const match = /<div class="counter" (data-v-[0-9a-f]+)>.*?<button class="([\w-]+)"[^>]*>(\d+)<\/button>/s.exec(html);
  if (!match) throw new Error(`no Counter markup in:\n${html}`);
  return {scope: match[1], button: match[2], count: match[3]};
}

/** `context` (the server's log) goes into the error: Vite answers a failed transform with a bare 404. */
async function fetchText(url: URL, context: () => string): Promise<string> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} for ${url}:\n${text}\n${context()}`);
  return text;
}

describe('Counter.ucf rendered on the server', () => {
  it('dev SSR in a fresh process gets the client module scope id', async () => {
    const server = startSsrServer(root);
    // Stopped here, not in onTestFinished: that runs after beforeEach's cleanup removes the copy.
    try {
      const url = await server.url;
      // The first request: ssrLoadModule() reaches Counter.ucf on a cold plugin-vue cache.
      const html = await fetchText(new URL(url), server.output);
      // The module the browser gets: App.vue's own import of Counter.ucf, as Vite rewrote it.
      const app = await fetchText(new URL('/src/App.vue', url), server.output);
      const counterUrl = moduleReferences(app).find(({specifier}) => /Counter\.ucf/.test(specifier))!.specifier;
      const code = await fetchText(new URL(counterUrl, url), server.output);

      const rendered = renderedCounter(html);
      expect(rendered.count).toBe('2');
      expect(rendered.scope).toBe(scopeAttribute(root, file, false));
      expect(exportedScopeId(code), code).toBe(rendered.scope);
      expect(server.output()).not.toMatch(/error/i);
    } finally {
      await server.stop();
    }
  });

  it('a production SSR bundle gets the scope id and class names of the client CSS', async () => {
    // Two processes, as an app's build script runs them: neither sees the other's plugin-vue cache.
    for (const args of [
      ['build', '--outDir', 'dist/client'],
      ['build', '--ssr', 'src/entry-server.ts', '--outDir', 'dist/server'],
    ]) {
      const vite = startViteCli(root, args, {NODE_ENV: 'production'});
      onTestFinished(() => vite.stop());
      await vite.finished();
    }
    const entry = pathToFileURL(join(root, 'dist', 'server', 'entry-server.js')).href;
    const {stdout: html} = await execNode(process.execPath, [
      '--input-type=module',
      '-e',
      `const {render} = await import(${JSON.stringify(entry)}); process.stdout.write(await render());`,
    ]);
    const assets = join(root, 'dist', 'client', 'assets');
    const cssFiles = (await readdir(assets)).filter((name) => name.endsWith('.css'));
    const css = (await Promise.all(cssFiles.map((name) => readFile(join(assets, name), 'utf8')))).join('\n');

    const rendered = renderedCounter(html);
    expect(rendered.count).toBe('2');
    expect(rendered.scope).toBe(scopeAttribute(root, file, true));
    expect(/\.counter\[(data-v-[0-9a-f]+)\]/.exec(css)?.[1]).toBe(rendered.scope);
    expect(css).toMatch(new RegExp(`\\.${rendered.button}\\s*\\{`));
  });
});
