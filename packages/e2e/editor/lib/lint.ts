// Shared by the lint specs of the server: its oxlint diagnostics, and the real mf-lint's findings in the same shape.
import type {Finding} from '@multifront/core';
import {expect} from 'vitest';
import {runMfLint} from './commands.ts';
import type {BinReport} from './commands.ts';
import {openUcf} from './lsp.ts';
import type {LanguageServer} from './lsp.ts';

type Diagnostic = Extract<Awaited<ReturnType<LanguageServer['sendDocumentDiagnosticRequest']>>, {kind: 'full'}>['items'][number];

/** What both sides report: the rule, the `.ucf` range and the LSP severity. */
export interface LintPoint {
  code: Diagnostic['code'];
  range: Diagnostic['range'];
  severity: Diagnostic['severity'];
}

/** The pulled diagnostics of `file` from oxlint, in `.ucf` order, its buffer first set to `text`. */
export async function lintDiagnostics(server: LanguageServer, file: string, text?: string): Promise<Diagnostic[]> {
  const document = await openUcf(server, file, text);
  const report = await server.sendDocumentDiagnosticRequest(document.uri);
  expect(report.kind).toBe('full');
  const items = report.kind === 'full' ? report.items.filter(({source}) => source === 'oxlint') : [];
  // oxlint lints the block files in parallel: their order is not the file's.
  return items.sort(
    ({range: first}, {range: second}) => first.start.line - second.start.line || first.start.character - second.start.character
  );
}

export const lintPoints = (diagnostics: Diagnostic[]): LintPoint[] =>
  diagnostics.map(({code, range, severity}) => ({code, range, severity}));

/** The real `mf-lint --format json` on `file` as it is on disk, run from `root`. */
export async function mfLintFindings(root: string, file: string): Promise<Finding[]> {
  const run = await runMfLint(root, [file, '--format', 'json']);
  expect(run.stderr).toBe('');
  return (JSON.parse(run.stdout) as BinReport<{files: number}>).findings;
}

/** A finding as the server must report it: 1-based line and column become 0-based. */
export const asLintPoint = ({code, line, column, end, severity}: Finding): LintPoint => ({
  code,
  range: {start: {line: line! - 1, character: column! - 1}, end: {line: end!.line - 1, character: end!.column - 1}},
  severity: severity === 'error' ? 1 : 2,
});
