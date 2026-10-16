// Shared by the format/ and lint/ specs: real oxfmt and oxlint CLIs, the fixture app, its expected outputs.
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {splitBlocks} from '@multifront/core';
import type {BlockTag} from '@multifront/core';
import {expect} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import type {BinReport} from './commands.ts';
import {E2E_DIR} from './tsserver.ts';

export const LINT_FORMAT = 'lint-format';
export const LINT_FORMAT_SVELTE = 'lint-format-svelte';
export const MESSY = 'Messy.ucf';

// The endings of the blocks of `Messy.ucf` that oxfmt formats with its `svelte` option off.
export const SENT: Partial<Record<BlockTag, string>> = {react: '.tsx', vue: '.vue', style: '.scss'};
// With oxfmt's `svelte` option on.
export const SENT_WITH_SVELTE: typeof SENT = {...SENT, svelte: '.svelte'};

const OXFMT_DIR = join(E2E_DIR, '..', '..', 'node_modules', 'oxfmt');
const OXFMT = join(OXFMT_DIR, 'bin', 'oxfmt');
export const OXLINT_DIR = join(E2E_DIR, '..', '..', 'node_modules', 'oxlint');
export const OXLINT = join(OXLINT_DIR, 'bin', 'oxlint');

export function oxfmtCli(cwd: string, stdinFilepath: string, text: string): string {
  return execFileSync(process.execPath, [OXFMT, '--stdin-filepath', stdinFilepath], {cwd, input: text, encoding: 'utf8'});
}

export const report = (stdout: string) => JSON.parse(stdout) as BinReport<{files: number; changed: string[]}>;

export const fails = (message: string) => ({code: 2, stdout: '', stderr: `mf-fmt: ${message}\n`});

export const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');

export const ORIGINAL = read(join(FIXTURES_DIR, 'apps', LINT_FORMAT), MESSY);

/** What `mf-fmt` must never change. */
export function outsideBlocks(source: string): string {
  const {blocks} = splitBlocks(source, MESSY);
  return blocks.reduceRight((text, block) => text.slice(0, block.contentStart) + text.slice(block.contentEnd), source);
}

export function contents(source: string): Partial<Record<BlockTag, string>> {
  return Object.fromEntries(splitBlocks(source, MESSY).blocks.map((block) => [block.type, block.content]));
}

export function copyInto(root: string, file: string, folders: string[]): void {
  for (const folder of folders) {
    mkdirSync(join(root, folder), {recursive: true});
    cpSync(join(root, file), join(root, folder, file));
  }
}

/** Each block oxfmt formats equals the oxfmt CLI's output for the same text, under the block file's name. */
export function expectCliOutput(root: string, file: string, newline = '\n', sent = SENT): void {
  const before = contents(ORIGINAL);
  const after = contents(read(root, file));
  for (const [tag, ending] of Object.entries(sent)) {
    const cli = oxfmtCli(root, `${file}.${tag}${ending}`, before[tag as BlockTag]!);
    // Flush left between the tags.
    expect(after[tag as BlockTag], `<${tag}> of ${file}`).toBe(`${newline}${cli.replace(/[\r\n]+$/, '')}${newline}`);
  }
}

/** The repo's own oxfmt, alone in `dir/node_modules`. */
export function linkOxfmt(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), {recursive: true});
  symlinkSync(realpathSync(OXFMT_DIR), join(dir, 'node_modules', 'oxfmt'), 'junction');
}

/** oxfmt and its dependencies minus svelte, copied into `dir/node_modules`: a link would find the repo's svelte. */
export function copyOxfmtWithoutSvelte(dir: string): void {
  const installed = dirname(realpathSync(OXFMT_DIR));
  for (const name of readdirSync(installed).filter((entry) => entry !== 'svelte')) {
    cpSync(join(installed, name), join(dir, 'node_modules', name), {recursive: true, dereference: true});
  }
}

/** Folders above `dir` with an oxfmt config, which a test outside the repo must not have. */
export function formatConfigsAbove(dir: string): string[] {
  const found: string[] = [];
  for (let folder = dirname(dir); ; folder = dirname(folder)) {
    if (['.oxfmtrc.json', '.oxfmtrc.jsonc'].some((name) => existsSync(join(folder, name)))) found.push(folder);
    if (dirname(folder) === folder) return found;
  }
}
