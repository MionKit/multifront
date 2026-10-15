// Fails once the pinned oxlint lints `.ucf` files itself, the upstream support `mf-lint` works around.
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import {LINT_FORMAT, OXLINT} from '../lib/format.ts';

interface OxlintReport {
  diagnostics: {filename: string; code: string; message: string}[];
  number_of_files: number;
}

const APP = join(FIXTURES_DIR, 'apps', LINT_FORMAT);

function oxlint(args: string[]): {code: number | null; report: OxlintReport} {
  const run = spawnSync(process.execPath, [OXLINT, '-f', 'json', ...args], {cwd: APP, encoding: 'utf8'});
  // With no file to lint, oxlint prints a plain line before its JSON report.
  return {code: run.status, report: JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as OxlintReport};
}

describe('oxlint on .ucf files', () => {
  it('lints none of them today', () => {
    const all = oxlint(['.']);
    const withoutUcf = oxlint(['--ignore-pattern', '**/*.ucf', '.']);
    expect(all.report.number_of_files).toBeGreaterThan(0);
    const ucf = all.report.diagnostics.filter(({filename}) => filename.endsWith('.ucf'));
    const upstream =
      `oxlint now lints .ucf files (${JSON.stringify(ucf)}): ` +
      "compare its findings with mf-lint's on the same files, then switch mf-lint to plain oxlint";
    expect({ucf, files: all.report.number_of_files}, upstream).toEqual({ucf: [], files: withoutUcf.report.number_of_files});
    expect([all.code, withoutUcf.code]).toEqual([0, 0]);
  });
});
