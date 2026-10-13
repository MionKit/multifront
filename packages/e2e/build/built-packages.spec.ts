import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, copyLibrary, removeLibrary} from '../fixtures/index.ts';
import {runMfBuild} from './lib/library.ts';

// One file: two `tsc --build` runs at once would race on the dist of the packages both reference.
const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function tsc(args: string[]): {status: number | null; output: string} {
  const result = spawnSync(process.execPath, [TSC, ...args], {cwd: REPO_ROOT, encoding: 'utf8'});
  return {status: result.status, output: result.stdout + result.stderr};
}

describe('the built @multifront/language-tools types', () => {
  it('give a consumer without the source condition the language plugin with its typescript field', () => {
    expect(tsc(['--build', 'packages/language-tools/tsconfig.build.json'])).toEqual({status: 0, output: ''});
    expect(tsc(['-p', join(FIXTURES_DIR, 'apps', 'language-tools-dist', 'tsconfig.json')])).toEqual({status: 0, output: ''});
  });
});

describe('the built mf-build command', () => {
  it('ships its bin and dist entry, and builds a library without the source condition', async () => {
    expect(tsc(['--build', 'packages/vite/tsconfig.build.json'])).toEqual({status: 0, output: ''});
    const packed = execFileSync('pnpm', ['pack', '--dry-run', '--json'], {
      cwd: join(REPO_ROOT, 'packages', 'vite'),
      encoding: 'utf8',
    });
    const files = (JSON.parse(packed) as {files: {path: string}[]}).files.map((file) => file.path);
    expect(files).toEqual(expect.arrayContaining(['bin/mf-build.js', 'dist/library/cli.js']));
    const root = await copyLibrary();
    try {
      const run = await runMfBuild(root, ['--framework', 'react', '--no-dts'], {source: false});
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, 'dist', 'react', 'package.json'), 'utf8')) as {name: string};
      expect(manifest.name).toBe('@mf-fixture/ui-react');
    } finally {
      await removeLibrary(root);
    }
  });
});
