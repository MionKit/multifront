// Plain `.svelte` files and a `.svelte.ts` module of a library, through mf-build, packed, in a fresh SvelteKit app.
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {runMfBuild} from '../build/lib/library.ts';
import {createConsumerApp, freePort, openPage, runInApp, serveApp} from './lib/app.ts';
import type {Command, ConsumerApp} from './lib/app.ts';
import {packLibrary} from './lib/pack.ts';

const CHILD = `<script lang="ts">
  import Icon from './Icon.ucf'
  import { count } from './count.svelte.js'

  let { label }: { label: string } = $props()
</script>

<button class="child" onclick={() => count.value++}><Icon /> {label}: {count.value}</button>

<style lang="scss">
  // SCSS only: the library's svelte.config.js turns it into CSS.
  $color: rgb(10, 20, 30);

  .child {
    color: $color;
  }
</style>
`;
const COUNT = `interface Count {
  value: number;
}

export const count: Count = $state({value: 0});

export function double(): number {
  return count.value * 2;
}
`;
// A component importing a plain file: the .ucf -> .svelte direction.
const SHELL = `<svelte>
  <script lang="ts">
  import Child from './Child.svelte'
  </script>

  <section class="shell"><Child label="shell" /></section>
</svelte>
`;
const SVELTE_CONFIG =
  "import {vitePreprocess} from '@sveltejs/vite-plugin-svelte';\n\nexport default {preprocess: vitePreprocess()};\n";
const INDEX = `export {default as Card} from './Card.ucf';
export {default as Shell} from './Shell.ucf';
export {default as Child} from './Child.svelte';
export {count, double} from './count.svelte.js';
`;
const PAGE = `<script lang="ts">
  import {onMount} from 'svelte';
  import {Card, Child, Shell, count, double} from '@mf-fixture/ui-svelte';

  const doubled: number = $derived(double());
  onMount(() => {
    document.body.dataset.hydrated = '';
  });
</script>

<main>
  <Card title="Hello">
    <Child label="page" />
  </Card>
  <Shell />
  <output id="count">{count.value}</output>
  <output id="double">{doubled}</output>
</main>
`;
const WRONG_PAGE = `<script lang="ts">
  import {Child, count} from '@mf-fixture/ui-svelte';

  const label: string = count.value;
</script>

<Child labl={label} />
`;
const SVELTE_CHECK: Command = [
  'pnpm',
  'exec',
  'svelte-check',
  '--tsconfig',
  './tsconfig.json',
  '--fail-on-warnings',
  '--output',
  'machine',
];

let root: string | undefined;
let built: Awaited<ReturnType<typeof runMfBuild>> | undefined;
let app: ConsumerApp | undefined;
let server: Awaited<ReturnType<typeof serveApp>> | undefined;
let viteBuild = '';
let setup: Promise<void> | undefined;

beforeAll(() => {
  setup = (async () => {
    root = await copyLibrary();
    const edits = {
      'src/Child.svelte': CHILD,
      'src/count.svelte.ts': COUNT,
      'src/Shell.ucf': SHELL,
      'src/index.ts': INDEX,
      'svelte.config.js': SVELTE_CONFIG,
    };
    for (const [file, content] of Object.entries(edits)) await writeFile(join(root, file), content);
    built = await runMfBuild(root, ['--framework', 'svelte']);
    if (built.code !== 0) throw new Error(`mf-build failed:\n${built.stderr}`);
    const {svelte: tarball} = await packLibrary(join(root, 'dist'));
    if (!tarball) throw new Error('mf-build packed no svelte tarball');
    app = await createConsumerApp('consumer-sveltekit', [tarball]);
    await writeFile(join(app.dir, 'src', 'routes', '+page.svelte'), PAGE);
    const build = await runInApp(app, ['pnpm', 'exec', 'vite', 'build']);
    if (build.code !== 0) throw new Error(`vite build failed:\n${build.output}`);
    viteBuild = build.output;
    const port = await freePort();
    // adapter-node takes its port from the env only.
    server = await serveApp(app, ['env', `PORT=${port}`, 'node', 'build'], port);
  })();
  return setup;
}, 600_000);

afterAll(async () => {
  // A timed-out setup keeps running: wait for it, then remove what it created late.
  await setup?.catch(() => {});
  await server?.close();
  await app?.remove();
  if (root) await removeLibrary(root);
}, 600_000);

function installed(file: string): string {
  return readFileSync(join(app!.dir, 'node_modules', '@mf-fixture', 'ui-svelte', file), 'utf8');
}

// Install runs no `prepare`: sync writes `.svelte-kit/tsconfig.json`, which the app's tsconfig extends.
async function svelteCheck() {
  const sync = await runInApp(app!, ['pnpm', 'exec', 'svelte-kit', 'sync']);
  if (sync.code !== 0) throw new Error(`svelte-kit sync failed:\n${sync.output}`);
  return runInApp(app!, SVELTE_CHECK);
}

describe('plain Svelte files of a library, packed, in a fresh SvelteKit app', () => {
  it('installs Child.svelte and count.svelte.js as preprocessed source, with their types', async () => {
    expect(built!.stderr).toBe('');
    const child = installed('Child.svelte');
    expect(child).toContain('import Icon from "./Icon.svelte"');
    expect(child).toContain('let { label }: { label: string } = $props()');
    expect(child).not.toContain('lang="scss"');
    expect(child).not.toContain('$color');
    expect(installed('count.svelte.js')).not.toContain('interface');
    expect(installed('Child.svelte.d.ts')).toMatch(/label: string/);
    expect(installed('count.svelte.d.ts')).toMatch(/value: number/);
    expect(existsSync(join(app!.dir, 'node_modules', '@mf-fixture', 'ui-svelte', 'count.svelte.ts'))).toBe(false);
    expect(await readFile(join(app!.dir, 'node_modules', '@mf-fixture', 'ui-svelte', 'Shell.svelte'), 'utf8')).toContain(
      "import Child from './Child.svelte'"
    );
  });

  it('type checks with real svelte-check, warnings included', async () => {
    const {code, output} = await svelteCheck();
    expect(output).toContain(' 0 ERRORS 0 WARNINGS ');
    expect(code, output).toBe(0);
  });

  it("fails svelte-check on a wrong Child prop and a wrong use of count's type", async () => {
    const dir = join(app!.dir, 'src', 'routes', 'wrong');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, '+page.svelte'), WRONG_PAGE);
    try {
      const {code, output} = await svelteCheck();
      expect(code, output).toBe(1);
      const errors = output.split('\n').filter((line) => line.includes(' ERROR '));
      expect(errors).toHaveLength(2);
      expect(errors.every((line) => line.includes('"src/routes/wrong/+page.svelte"'))).toBe(true);
      expect(errors.join('\n')).toContain("Type 'number' is not assignable to type 'string'");
      expect(errors.join('\n')).toContain('labl');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('builds with real vite build and adapter-node', () => {
    expect(viteBuild).toContain('built in');
    expect(viteBuild).toContain('Using @sveltejs/adapter-node');
  });

  it('server renders both Child buttons, from the page and from Shell.ucf', async () => {
    const html = await (await fetch(server!.url)).text();
    expect(html).toMatch(/<button class="child svelte-[a-z0-9]+">.*? page: 0<\/button>/);
    expect(html).toMatch(
      /<section [^>]*class="[^"]*shell[^"]*"[^>]*><button class="child svelte-[a-z0-9]+">.*? shell: 0<\/button>/
    );
    expect(html).toContain('<output id="double">0</output>');
  });

  it('hydrates: the SCSS color applies, one click updates the shared runes state everywhere, no console problem', async () => {
    const {page, messages, close} = await openPage(server!.url);
    try {
      await page.locator('body[data-hydrated]').waitFor({state: 'attached'});
      const child = page.locator('button.child', {hasText: 'page'});
      expect(await computed(child, 'color')).toBe('rgb(10, 20, 30)');
      await child.click();
      await expect.poll(() => page.locator('#count').textContent()).toBe('1');
      expect(await page.locator('#double').textContent()).toBe('2');
      expect(await page.locator('button.child', {hasText: 'shell'}).textContent()).toContain('shell: 1');
      expect(consoleProblems(messages)).toEqual([]);
    } finally {
      await close();
    }
  });
});
