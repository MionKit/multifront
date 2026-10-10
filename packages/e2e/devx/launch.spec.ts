import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true});
});

// A copy of scripts/ beside the real node_modules entries, oxlint swapped for `replacement` (or left out).
function repoWithOxlint(replacement?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'devx-'));
  temps.push(root);
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), {recursive: true});
  mkdirSync(join(root, 'node_modules'));
  for (const name of readdirSync(join(REPO_ROOT, 'node_modules'))) {
    if (name === 'oxlint' || name.startsWith('.')) continue;
    symlinkSync(join(REPO_ROOT, 'node_modules', name), join(root, 'node_modules', name), 'junction');
  }
  if (replacement) symlinkSync(join(REPO_ROOT, 'node_modules', replacement), join(root, 'node_modules', 'oxlint'), 'junction');
  return root;
}

function devx(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'devx.mjs'), ...args], {
    encoding: 'utf8',
    env: {...process.env, CI: '1'},
  });
}

describe('devx tool launch', () => {
  it('runs a tool through its package bin entry', () => {
    const result = devx(REPO_ROOT, 'commitlint', '--version');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^@commitlint\/cli@\d/);
  });

  it('names the missing package when a tool is not installed', () => {
    const result = devx(repoWithOxlint(), 'lint');
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('devx: oxlint is not installed, run pnpm install');
  });

  it('names the package when it has no entry for the tool', () => {
    const result = devx(repoWithOxlint('@types/node'), 'lint');
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('devx: oxlint is not installed, run pnpm install');
  });
});
