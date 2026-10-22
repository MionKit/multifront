// Plain `.svelte` files and a `.svelte.ts` module of a library, through mf-build, packed, in a fresh SvelteKit app.
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {computed, consoleProblems} from '../browser/lib/chromium.ts';
import {copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {CHILD, COUNT, SVELTE_CONFIG, runMfBuild} from '../build/lib/library.ts';
import {openPage, serveConsumerApp, svelteCheck} from './lib/app.ts';
import {packLibrary} from './lib/pack.ts';

const DOUBLE = `${COUNT}
export function double(): number {
  return count.value * 2;
}
`;
// A component importing a plain file: the .front -> .svelte direction.
const SHELL = `<svelte lang="html">
  <script lang="ts">
  import Child from './Child.svelte'
  </script>

  <section class="shell"><Child label="shell" /></section>
</svelte>
`;
const INDEX = `export {default as Card} from './Card.front';
export {default as Shell} from './Shell.front';
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
let mfBuild: Awaited<ReturnType<typeof runMfBuild>> | undefined;

async function plainLibraryTarballs() {
  const root = await copyLibrary();
  try {
    const edits = {
      'src/Child.svelte': CHILD,
      'src/count.svelte.ts': DOUBLE,
      'src/Shell.front': SHELL,
      'src/index.ts': INDEX,
      'svelte.config.js': SVELTE_CONFIG,
    };
    for (const [file, content] of Object.entries(edits)) await writeFile(join(root, file), content);
    mfBuild = await runMfBuild(root, ['--framework', 'svelte']);
    if (mfBuild.code !== 0) throw new Error(`mf-build failed:\n${mfBuild.stdout}${mfBuild.stderr}`);
    return {tarballs: await packLibrary(join(root, 'dist')), remove: () => removeLibrary(root)};
  } catch (err) {
    await removeLibrary(root);
    throw err;
  }
}

const served = serveConsumerApp({
  target: 'svelte',
  template: 'consumer-sveltekit',
  build: ['pnpm', 'exec', 'vite', 'build'],
  // adapter-node takes its port from the env only.
  serve: (port) => ['env', `PORT=${port}`, 'node', 'build'],
  tarballs: plainLibraryTarballs,
  prepare: (app) => writeFile(join(app.dir, 'src', 'routes', '+page.svelte'), PAGE),
  timeout: 600_000,
});

function installed(file: string): string {
  return join(served().app.dir, 'node_modules', '@mf-fixture', 'ui-svelte', file);
}

describe('plain Svelte files of a library, packed, in a fresh SvelteKit app', () => {
  it('installs Child.svelte and count.svelte.js as preprocessed source, with their types', () => {
    const read = (file: string) => readFileSync(installed(file), 'utf8');
    expect(mfBuild!.stderr).toBe('');
    const child = read('Child.svelte');
    expect(child).toContain('import Icon from "./Icon.svelte"');
    expect(child).toContain('let { label }: { label: string } = $props()');
    expect(child).not.toContain('lang="scss"');
    expect(child).not.toContain('$color');
    expect(read('count.svelte.js')).not.toContain('interface');
    expect(read('Child.svelte.d.ts')).toMatch(/label: string/);
    expect(read('count.svelte.d.ts')).toMatch(/value: number/);
    expect(existsSync(installed('count.svelte.ts'))).toBe(false);
    expect(read('Shell.svelte')).toContain("import Child from './Child.svelte'");
  });

  it('type checks with real svelte-check, warnings included', async () => {
    const {code, output} = await svelteCheck(served().app);
    expect(output).toContain(' 0 ERRORS 0 WARNINGS ');
    expect(code, output).toBe(0);
  });

  it("fails svelte-check on a wrong Child prop and a wrong use of count's type", async () => {
    const dir = join(served().app.dir, 'src', 'routes', 'wrong');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, '+page.svelte'), WRONG_PAGE);
    try {
      const {code, output} = await svelteCheck(served().app);
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
    expect(served().build).toContain('built in');
    expect(served().build).toContain('Using @sveltejs/adapter-node');
  });

  it('server renders both Child buttons, from the page and from Shell.front', async () => {
    const html = await (await fetch(served().url)).text();
    expect(html).toMatch(/<button class="child svelte-[a-z0-9]+">.*? page: 0<\/button>/);
    expect(html).toMatch(
      /<section [^>]*class="[^"]*shell[^"]*"[^>]*><button class="child svelte-[a-z0-9]+">.*? shell: 0<\/button>/
    );
    expect(html).toContain('<output id="double">0</output>');
  });

  it('hydrates: the SCSS color applies, one click updates the shared runes state everywhere, no console problem', async () => {
    const {page, messages, close} = await openPage(served().url);
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
