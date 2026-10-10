import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';

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
