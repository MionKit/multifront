// Fails once the pinned oxlint lints `.ucf` files itself, the gap `mf-lint` works around.
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

describe('oxlint on .ucf files', () => {
  it('lints none of them today', () => {
    const all = oxlint(['.']);
    const withoutUcf = oxlint(['--ignore-pattern', '**/*.ucf', '.']);
    expect(all.report.number_of_files).toBeGreaterThan(0);
    const ucf = all.report.diagnostics.filter(({filename}) => filename.endsWith('.ucf'));
    const switchToOxlint =
      `oxlint now lints .ucf files (${JSON.stringify(ucf)}): ` +
      "compare its findings with mf-lint's on the same files, then switch mf-lint to plain oxlint";
    expect({ucf, files: all.report.number_of_files}, switchToOxlint).toEqual({ucf: [], files: withoutUcf.report.number_of_files});
    expect([all.code, withoutUcf.code]).toEqual([0, 0]);
  });
});
