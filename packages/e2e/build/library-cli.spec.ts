import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {mkdir, rm} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {normalizePath} from 'vite';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {runMfBuild, withEditedLibrary} from './lib/library.ts';

const UNKNOWN_ANGULAR = "mf-build: buildLibrary: unknown framework 'angular'; use vue, react, svelte";
const ANGULAR_CONFIG = "export default {frameworks: ['angular']};\n";

function packageName(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {name: string}).name;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe('mf-build', () => {
  it('builds every target with the names of multifront.config.ts', async () => {
    const root = await copyLibrary();
    try {
      const run = await runMfBuild(root);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const dist = join(root, 'dist');
      expect(readdirSync(dist).sort()).toEqual(['react', 'svelte', 'vue']);
      expect(packageName(join(dist, 'react'))).toBe('@mf-fixture/ui-react');
      expect(packageName(join(dist, 'vue'))).toBe('@mf-fixture/ui-vue');
      expect(packageName(join(dist, 'svelte'))).toBe('@mf-fixture/ui-svelte');
      const count = (target: string) => filesUnder(join(dist, target)).length;
      expect(run.stdout.split('\n')).toEqual([
        `vue: ${count('vue')} files in dist/vue (@mf-fixture/ui-vue)`,
        `react: ${count('react')} files in dist/react (@mf-fixture/ui-react), skipped VueOnly.ucf`,
        `svelte: ${count('svelte')} files in dist/svelte (@mf-fixture/ui-svelte), skipped Badge.ucf, VueOnly.ucf`,
        '',
      ]);
    } finally {
      await removeLibrary(root);
    }
  });

  it('lets --root, --framework, --out-dir and --no-dts win over the config', async () => {
    const config = `import {defineLibrary} from '@multifront/vite';

export default defineLibrary({
  root: 'nowhere',
  frameworks: ['react'],
  outDir: 'elsewhere',
  dts: true,
  packages: {vue: {name: '@acme/cards-vue'}},
});
`;
    await withEditedLibrary([{file: 'multifront.config.ts', content: config}], async (root) => {
      const run = await runMfBuild(FIXTURES_DIR, ['--root', root, '--framework', 'vue', '--no-dts', '--out-dir', 'out']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const outDir = join(root, 'out', 'vue');
      expect(readdirSync(join(root, 'out'))).toEqual(['vue']);
      expect(existsSync(join(root, 'elsewhere'))).toBe(false);
      expect(packageName(outDir)).toBe('@acme/cards-vue');
      expect(filesUnder(outDir).filter((file) => file.endsWith('.d.ts'))).toEqual([]);
      const shown = normalizePath(relative(FIXTURES_DIR, outDir));
      expect(run.stdout).toBe(`vue: ${filesUnder(outDir).length} files in ${shown} (@acme/cards-vue)\n`);
    });
  });

  it('builds with the defaults when there is no config, and shows the out dir it runs in as .', async () => {
    await withEditedLibrary([], async (root) => {
      await rm(join(root, 'multifront.config.ts'));
      const outDir = join(root, 'dist', 'vue');
      await mkdir(outDir, {recursive: true});
      const run = await runMfBuild(outDir, ['--root', '../..', '--framework', 'vue', '--no-dts']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      expect(packageName(outDir)).toBe('@mf-fixture/ui-vue');
      expect(run.stdout).toBe(`vue: ${filesUnder(outDir).length} files in . (@mf-fixture/ui-vue)\n`);
    });
  });

  it.each([
    {name: '.ts before .js', files: {ts: ANGULAR_CONFIG, js: 'export default 5;\n'}, error: UNKNOWN_ANGULAR},
    {name: '.js before .mjs', files: {js: ANGULAR_CONFIG, mjs: 'export default 5;\n'}, error: UNKNOWN_ANGULAR},
    {
      name: 'a config that is no object',
      files: {mjs: 'export default 5;\n'},
      error: 'mf-build: cannot load <root>/multifront.config.mjs: config must export or return an object.',
    },
    {
      name: 'a config that throws a string',
      files: {mjs: "throw 'bad config';\n"},
      error: 'mf-build: cannot load <root>/multifront.config.mjs: bad config',
    },
    {
      name: 'frameworks as a string',
      files: {mjs: "export default {frameworks: 'vue'};\n"},
      error: 'mf-build: buildLibrary: frameworks must be an array of framework names, got "vue"',
    },
  ])('exits 1 with the message: $name', async ({files, error}) => {
    const edits = Object.entries(files).map(([ext, content]) => ({file: `multifront.config.${ext}`, content}));
    await withEditedLibrary(edits, async (root) => {
      if (!('ts' in files)) await rm(join(root, 'multifront.config.ts'));
      const run = await runMfBuild(root);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(error.replace('<root>', root));
      expect(run.stdout).toBe('');
      expect(existsSync(join(root, 'dist'))).toBe(false);
    });
  });

  it('passes every repeated --framework on', async () => {
    await withEditedLibrary([], async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--framework', 'angular', '--out-dir', 'out']);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(UNKNOWN_ANGULAR);
      expect(existsSync(join(root, 'out'))).toBe(false);
    });
  });

  it.each([
    {args: ['--outdir', 'x'], error: "mf-build: Unknown option '--outdir'"},
    {args: ['src'], error: "mf-build: Unexpected argument 'src'"},
  ])('exits 1 on $args', async ({args, error}) => {
    await withEditedLibrary([], async (root) => {
      const run = await runMfBuild(root, args);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(error);
      expect(existsSync(join(root, 'dist'))).toBe(false);
    });
  });
});
