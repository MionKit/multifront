// What the `mf-fmt` specs share: the real oxfmt CLI, the fixture app and its expected outputs.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {splitBlocks} from '@multifront/core';
import type {BlockTag} from '@multifront/core';
import type {BinReport} from './commands.ts';
import {E2E_DIR} from './tsserver.ts';

export const LINT_FORMAT = 'lint-format';
export const MESSY = 'Messy.ucf';

// The endings of the blocks of `Messy.ucf` that oxfmt formats; `<svelte>` stays as written.
export const SENT: Partial<Record<BlockTag, string>> = {react: '.tsx', vue: '.vue', style: '.scss'};

const OXFMT_DIR = join(E2E_DIR, '..', '..', 'node_modules', 'oxfmt');
const OXFMT = join(OXFMT_DIR, 'bin', 'oxfmt');

/** The real oxfmt CLI on `text`, named `stdinFilepath`, run from `cwd`. */
export function oxfmtCli(cwd: string, stdinFilepath: string, text: string): string {
  return execFileSync(process.execPath, [OXFMT, '--stdin-filepath', stdinFilepath], {cwd, input: text, encoding: 'utf8'});
}

export const report = (stdout: string) => JSON.parse(stdout) as BinReport<{files: number; changed: string[]}>;

export const fails = (message: string) => ({code: 2, stdout: '', stderr: `mf-fmt: ${message}\n`});

export const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');

/** The source with every block's content cut out: what `mf-fmt` must never change. */
export function outsideBlocks(source: string): string {
  const {blocks} = splitBlocks(source, MESSY);
  return blocks.reduceRight((text, block) => text.slice(0, block.contentStart) + text.slice(block.contentEnd), source);
}

/** Each block's content of `source`, by tag. */
export function contents(source: string): Partial<Record<BlockTag, string>> {
  return Object.fromEntries(splitBlocks(source, MESSY).blocks.map((block) => [block.type, block.content]));
}

/** The repo's own oxfmt in `dir/node_modules`, and nothing else there. */
export function linkOxfmt(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), {recursive: true});
  symlinkSync(realpathSync(OXFMT_DIR), join(dir, 'node_modules', 'oxfmt'), 'junction');
}

/** Folders above `dir` with an oxfmt config, which a test outside the repo must not have. */
export function formatConfigsAbove(dir: string): string[] {
  const found: string[] = [];
  for (let folder = dirname(dir); ; folder = dirname(folder)) {
    if (['.oxfmtrc.json', '.oxfmtrc.jsonc'].some((name) => existsSync(join(folder, name)))) found.push(folder);
    if (dirname(folder) === folder) return found;
  }
}
