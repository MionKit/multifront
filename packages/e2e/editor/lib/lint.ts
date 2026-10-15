// What the `mf-lint` specs share: the fixture's expected findings and temp copy helpers.
import {cpSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {splitBlocks} from '@multifront/core';
import type {BlockTag, Finding, Target} from '@multifront/core';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import type {BinReport} from './commands.ts';
import {tsLocation} from './tsserver.ts';

export const LINT = 'Lint.ucf';
export const CLEAN = 'Clean.ucf';

export const UNUSED = "Variable 'unused' is declared but never used. Unused variables should start with a '_'.";
export const DEBUGGER = '`debugger` statement is not allowed';

export const LINT_SOURCE = readFileSync(join(FIXTURES_DIR, 'apps', 'lint-format', LINT), 'utf8');

export const report = (stdout: string) => JSON.parse(stdout) as BinReport<{files: number}>;

export const fails = (message: string) => ({code: 2, stdout: '', stderr: `mf-lint: ${message}\n`});

/** `needle` inside the `tag` block of `source`, as 1-based finding positions. */
export function inBlock(source: string, tag: BlockTag, needle: string): Pick<Finding, 'line' | 'column' | 'end'> {
  const block = splitBlocks(source, LINT).blocks.find(({type}) => type === tag)!;
  const start = block.contentStart + block.content.indexOf(needle);
  if (start < block.contentStart) throw new Error(`${needle} not in <${tag}>`);
  const [from, to] = [tsLocation(source, start), tsLocation(source, start + needle.length)];
  return {line: from.line, column: from.offset, end: {line: to.line, column: to.offset}};
}

/** A finding of `Lint.ucf`, on `needle` in its `tag` block. */
export function lintFinding(
  file: string,
  tag: Target,
  needle: string,
  code: string,
  severity: Finding['severity'],
  message: string,
  source = LINT_SOURCE
): Finding {
  return {file, ...inBlock(source, tag, needle), code, severity, message, block: tag, framework: tag};
}

/** What the fixture config reports on `Lint.ucf`: no `no-unused-vars` in `.vue` or `.svelte` files, as oxlint lints them. */
export function lintFindings(file = LINT): Finding[] {
  return [
    lintFinding(file, 'react', 'unused', 'eslint(no-unused-vars)', 'warning', UNUSED),
    lintFinding(file, 'react', 'debugger;', 'eslint(no-debugger)', 'warning', DEBUGGER),
    lintFinding(file, 'vue', 'debugger;', 'eslint(no-debugger)', 'error', DEBUGGER),
    lintFinding(file, 'svelte', 'debugger;', 'eslint(no-debugger)', 'error', DEBUGGER),
  ];
}

export function copyLint(root: string, folders: string[]): void {
  for (const folder of folders) {
    mkdirSync(join(root, folder), {recursive: true});
    cpSync(join(root, LINT), join(root, folder, LINT));
  }
}
