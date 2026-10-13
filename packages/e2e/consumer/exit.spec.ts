// The M6 exit test: the real mf-build bin, packed, installed into four fresh apps, type checked, built, served, rendered.
import {execFile} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import type {Target} from '@multifront/core';
import type {Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {consoleProblems} from '../browser/lib/chromium.ts';
import {styles} from '../browser/lib/parity.ts';
import {copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {runMfBuild} from '../build/lib/library.ts';
import {createConsumerApp, freePort, openPage, runInApp, serveApp} from './lib/app.ts';
import type {Command, ConsumerApp} from './lib/app.ts';
import {packLibrary, publint} from './lib/pack.ts';
import type {ToolRun} from './lib/pack.ts';

const require = createRequire(import.meta.url);
const ATTW = join(dirname(require.resolve('@arethetypeswrong/cli/package.json')), 'dist', 'index.js');

// node16 looks for `Card.d.svelte.ts` behind a `./Card.svelte` import: every svelte-package layout fails it.
const ATTW_EXTRA: Partial<Record<Target, string[]>> = {svelte: ['--ignore-rules', 'internal-resolution-error']};

function attw(target: Target, tarball: string): Promise<ToolRun> {
  const args = [ATTW, tarball, '--profile', 'esm-only', '--exclude-entrypoints', 'styles.css', '--no-definitely-typed'];
  return promisify(execFile)(process.execPath, [...args, ...(ATTW_EXTRA[target] ?? [])], {
    env: {...process.env, NO_COLOR: '1'},
  }).then(
    ({stdout, stderr}) => ({code: 0, output: `${stdout}${stderr}`}),
    (err: {code?: number; stdout?: string; stderr?: string}) => ({code: err.code ?? 1, output: `${err.stdout}${err.stderr}`})
  );
}

interface ExitApp {
  template: string;
  target: Target;
  check: Command[];
  build: Command;
  serve: (port: number) => Command;
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

const PARITY = ['padding', 'color', 'border-radius', 'font-size'];

interface Rendered {
  card: Record<string, string>;
  title: Record<string, string>;
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
    await Promise.all(
      APPS.map(async ({template, target}) => installed.set(template, await createConsumerApp(template, [tarballs[target]!])))
    );
  })();
  return setup;
}, 900_000);

afterAll(async () => {
  // A timed-out setup keeps running: what it creates late must be removed too.
  await setup?.catch(() => {});
  await Promise.all([...installed.values()].map((app) => app.remove()));
  if (root) await removeLibrary(root);
});

async function renderedOn(page: Page): Promise<Rendered> {
  const card = page.locator('article.card');
  const scope = await card.evaluate((element) =>
    element.getAttributeNames().filter((name: string) => name.startsWith('data-v-'))
  );
  return {card: await styles(card, PARITY), title: await styles(card.locator('h2'), PARITY), scope};
}

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
    const typed = await attw(target, tarball!);
    expect(typed.code, typed.output).toBe(0);
  });

  it.each(APPS)(
    '$template: type checks, builds, serves, renders Card, Counter and Button, counts a click, no console problem',
    async ({template, check, build, serve, hydrates}) => {
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
        const {page, messages, close} = await openPage(server.url);
        try {
          await page.locator('article.card').waitFor();
          await page.locator('button', {hasText: 'Go'}).waitFor();
          if (hydrates) await page.locator('body[data-hydrated]').waitFor({state: 'attached'});
          const counter = page.locator('button.counter');
          expect(await counter.textContent()).toBe('Count 0');
          await counter.click();
          await expect.poll(() => counter.textContent()).toBe('Count 1');
          rendered.set(template, await renderedOn(page));
          expect(consoleProblems(messages)).toEqual([]);
        } finally {
          await close();
        }
      } finally {
        await server.close();
      }
    },
    300_000
  );

  it('gives Card the same computed styles and the same scope attribute in all four apps', () => {
    expect([...rendered.keys()].sort()).toEqual(APPS.map(({template}) => template).sort());
    const [first, ...rest] = [...rendered.entries()];
    for (const [template, seen] of rest) expect({template, ...seen}).toEqual({template, ...first![1]});
    expect(first![1].scope).toHaveLength(1);
  });
});
