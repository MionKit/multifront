// Fails once the pinned oxlint lints `.front` files itself, the gap `mf-lint` works around.
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import {LINT_FORMAT, OXLINT} from '../lib/format.ts';

const APP = join(FIXTURES_DIR, 'apps', LINT_FORMAT);

function oxlint(args: string[]) {
  const run = spawnSync(process.execPath, [OXLINT, '-f', 'json', ...args], {cwd: APP, encoding: 'utf8'});
  expect(run.stdout, run.stderr || String(run.error)).toMatch(/^\s*\{/);
  return {code: run.status, report: JSON.parse(run.stdout) as {diagnostics: {filename: string}[]; number_of_files: number}};
}

describe('oxlint on .front files', () => {
  it('lints none of them today', () => {
    const all = oxlint(['.']);
    const withoutFront = oxlint(['--ignore-pattern', '**/*.front', '.']);
    expect(all.report.number_of_files).toBeGreaterThan(0);
    const front = all.report.diagnostics.filter(({filename}) => filename.endsWith('.front'));
    const switchToOxlint =
      `oxlint now lints .front files (${JSON.stringify(front)}): ` +
      "compare its findings with mf-lint's on the same files, then switch mf-lint to plain oxlint";
    expect({front, files: all.report.number_of_files}, switchToOxlint).toEqual({
      front: [],
      files: withoutFront.report.number_of_files,
    });
    expect([all.code, withoutFront.code]).toEqual([0, 0]);
  });
});
