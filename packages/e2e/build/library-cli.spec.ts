import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {normalizePath} from 'vite';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, LIBRARY_DIR, TMP_DIR, copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {runMfBuild, withEditedLibrary} from './lib/library.ts';

const UNKNOWN_ANGULAR = "mf-build: buildLibrary: unknown framework 'angular'; use vue, react, svelte";

function packageName(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {name: string}).name;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

async function withOutDir(run: (outDir: string) => Promise<void>): Promise<void> {
  await mkdir(TMP_DIR, {recursive: true});
  const outDir = await mkdtemp(join(TMP_DIR, 'library-dist-'));
  try {
    await run(outDir);
  } finally {
    await removeLibrary(outDir);
  }
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
    const config = `import {defineLibrary} from '@multifront/vite';\n\nexport default defineLibrary({packages: {vue: {name: '@acme/cards-vue'}}});\n`;
    await withEditedLibrary([{file: 'multifront.config.ts', content: config}], (root) =>
      withOutDir(async (outDir) => {
        const run = await runMfBuild(FIXTURES_DIR, ['--root', root, '--framework', 'vue', '--no-dts', '--out-dir', outDir]);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(readdirSync(outDir)).toEqual(['vue']);
        expect(packageName(join(outDir, 'vue'))).toBe('@acme/cards-vue');
        expect(filesUnder(join(outDir, 'vue')).filter((file) => file.endsWith('.d.ts'))).toEqual([]);
        const shown = normalizePath(relative(FIXTURES_DIR, join(outDir, 'vue')));
        const count = filesUnder(join(outDir, 'vue')).length;
        expect(run.stdout).toBe(`vue: ${count} files in ${shown} (@acme/cards-vue)\n`);
      })
    );
  });

  it('exits 1 with the message when a multifront.config.mjs names an unknown framework', async () => {
    await withEditedLibrary(
      [{file: 'multifront.config.mjs', content: "export default {frameworks: ['angular']};\n"}],
      async (root) => {
        await rm(join(root, 'multifront.config.ts'));
        const run = await runMfBuild(root);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(UNKNOWN_ANGULAR);
        expect(run.stdout).toBe('');
        expect(existsSync(join(root, 'dist'))).toBe(false);
      }
    );
  });

  it('passes every repeated --framework on', async () => {
    await withOutDir(async (outDir) => {
      const run = await runMfBuild(LIBRARY_DIR, ['--framework', 'vue', '--framework', 'angular', '--out-dir', outDir]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(UNKNOWN_ANGULAR);
      expect(readdirSync(outDir)).toEqual([]);
    });
  });

  it('exits 1 on an unknown flag', async () => {
    const run = await runMfBuild(LIBRARY_DIR, ['--outdir', 'x']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("mf-build: Unknown option '--outdir'");
    expect(existsSync(join(LIBRARY_DIR, 'x'))).toBe(false);
  });
});
