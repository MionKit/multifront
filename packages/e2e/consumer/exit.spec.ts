// The M6 exit test: the real mf-build bin, packed, installed into four fresh apps, type checked, built, served, rendered.
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {Target} from '@multifront/core';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {computed} from '../browser/lib/chromium.ts';
import {copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {runMfBuild} from '../build/lib/library.ts';
import {KEY_STYLES, createConsumerApp, expectHydrates, freePort, keyStyles, runInApp, serveApp} from './lib/app.ts';
import type {Command, ConsumerApp, ServedAppOptions} from './lib/app.ts';
import {attw, packLibrary, publint} from './lib/pack.ts';

// node16 looks for `Card.d.svelte.ts` behind a `./Card.svelte` import: every svelte-package layout fails it.
const ATTW_EXTRA: Partial<Record<Target, string[]>> = {svelte: ['--ignore-rules', 'internal-resolution-error']};

interface ExitApp extends ServedAppOptions {
  check: Command[];
  // Server rendered: the page marks `body[data-hydrated]` once hydrated, and the click waits for it.
  hydrates: boolean;
}

const APPS: ExitApp[] = [
  {
    template: 'consumer-next',
    target: 'react',
    check: [['pnpm', 'exec', 'tsc', '--noEmit', '--pretty', 'false']],
    build: ['pnpm', 'exec', 'next', 'build'],
    serve: (port) => ['pnpm', 'exec', 'next', 'start', '--port', String(port)],
    hydrates: true,
  },
  {
    template: 'consumer-vite-react',
    target: 'react',
    check: [['pnpm', 'exec', 'tsc', '--noEmit', '--pretty', 'false']],
    build: ['pnpm', 'exec', 'vite', 'build'],
    serve: (port) => ['pnpm', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort'],
    hydrates: false,
  },
  {
    template: 'consumer-vite-vue',
    target: 'vue',
    check: [['pnpm', 'exec', 'vue-tsc', '--noEmit', '--pretty', 'false']],
    build: ['pnpm', 'exec', 'vite', 'build'],
    serve: (port) => ['pnpm', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort'],
    hydrates: false,
  },
  {
    template: 'consumer-sveltekit',
    target: 'svelte',
    // `pnpm install` runs no `prepare`: sync writes `.svelte-kit/tsconfig.json`, which the app's tsconfig extends.
    check: [
      ['pnpm', 'exec', 'svelte-kit', 'sync'],
      ['pnpm', 'exec', 'svelte-check', '--tsconfig', './tsconfig.json', '--fail-on-warnings'],
    ],
    build: ['pnpm', 'exec', 'vite', 'build'],
    // adapter-node takes its port from the env only.
    serve: (port) => ['env', `PORT=${port}`, 'node', 'build'],
    hydrates: true,
  },
];

interface Rendered {
  styles: typeof KEY_STYLES;
  scope: string[];
}

let root: string | undefined;
let tarballs: Partial<Record<Target, string>> = {};
let built: Awaited<ReturnType<typeof runMfBuild>> | undefined;
const installed = new Map<string, ConsumerApp>();
const rendered = new Map<string, Rendered>();
let setup: Promise<void> | undefined;

beforeAll(() => {
  setup = (async () => {
    root = await copyLibrary();
    built = await runMfBuild(root);
    if (built.code !== 0) throw new Error(`mf-build failed:\n${built.stderr}`);
    tarballs = await packLibrary(join(root, 'dist'));
    // allSettled: one failed install must not leave the others landing after afterAll has run.
    const installs = await Promise.allSettled(
      APPS.map(async ({template, target}) => {
        const tarball = tarballs[target];
        if (!tarball) throw new Error(`no ${target} tarball among ${JSON.stringify(tarballs)}`);
        installed.set(template, await createConsumerApp(template, [tarball]));
      })
    );
    for (const install of installs) if (install.status === 'rejected') throw install.reason;
  })();
  return setup;
}, 900_000);

afterAll(async () => {
  // A timed-out setup keeps running: wait for it (hence setup's timeout), then remove what it created late.
  await setup?.catch(() => {});
  await Promise.all([...installed.values()].map((app) => app.remove()));
  if (root) await removeLibrary(root);
}, 900_000);

describe('M6 exit: mf-build, packed, in four fresh apps', () => {
  it('builds every framework with the real mf-build bin', () => {
    expect(built!.stderr).toBe('');
    expect(built!.stdout).toMatch(/^react: \d+ files in dist\/react \(@mf-fixture\/ui-react\)/m);
    expect(built!.stdout).toMatch(/^vue: \d+ files in dist\/vue \(@mf-fixture\/ui-vue\)/m);
    expect(built!.stdout).toMatch(/^svelte: \d+ files in dist\/svelte \(@mf-fixture\/ui-svelte\)/m);
  });

  it.each(['react', 'vue', 'svelte'] as const)('packs %s into a tarball that passes publint and attw', async (target) => {
    const tarball = tarballs[target];
    expect(tarball).toBeDefined();
    const linted = await publint(tarball!);
    expect(linted.code, linted.output).toBe(0);
    const typed = await attw(tarball!, ATTW_EXTRA[target]);
    expect(typed.code, typed.output).toBe(0);
  });

  it.each(APPS)(
    '$template: type checks, builds, serves, renders Card, Counter and Button, counts a click, no console problem',
    async ({template, target, check, build, serve, hydrates}) => {
      const app = installed.get(template)!;
      expect(readdirSync(join(app.dir, 'node_modules', '.pnpm')).filter((name) => name.startsWith('@multifront+'))).toEqual([]);
      for (const command of check) {
        const {code, output} = await runInApp(app, command);
        expect(code, `${command.join(' ')}:\n${output}`).toBe(0);
      }
      const {code, output} = await runInApp(app, build);
      expect(code, `${build.join(' ')}:\n${output}`).toBe(0);

      const port = await freePort();
      const server = await serveApp(app, serve(port), port);
      try {
        await expectHydrates(
          server.url,
          'button.counter',
          async (page) => {
            const button = page.locator('button', {hasText: 'Go'});
            await button.waitFor();
            // The caller's class and style reach Button's root; Svelte's page passes neither.
            if (target !== 'svelte') {
              expect((await button.getAttribute('class'))!.split(' ')).toContain('extra');
              expect(await computed(button, 'color')).toBe('rgb(255, 0, 0)');
            }
            if (template === 'consumer-vite-react')
              await expect.poll(() => page.locator('#button-ref').textContent()).toBe('BUTTON');
            const scope = await page
              .locator('article.card')
              .evaluate((element) => element.getAttributeNames().filter((name: string) => name.startsWith('data-v-')));
            rendered.set(template, {styles: await keyStyles(page), scope});
          },
          {hydrates}
        );
      } finally {
        await server.close();
      }
    },
    300_000
  );

  it('gives Card the library styles and the same scope attribute in all four apps', () => {
    expect([...rendered.keys()].sort()).toEqual(APPS.map(({template}) => template).sort());
    const first = rendered.get(APPS[0]!.template)!;
    expect(first.scope).toHaveLength(1);
    for (const [template, {styles, scope}] of rendered)
      expect({template, styles, scope}).toEqual({template, styles: KEY_STYLES, scope: first.scope});
  });
});
