// What the `mf-tsc` specs share: the fixture apps' expected findings and temp copy helpers.
import {existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname, join, parse} from 'node:path';
import type {Finding} from '@multifront/core';
import {expect} from 'vitest';
import {edited} from '../../build/lib/library.ts';
import {FIXTURES_DIR, copyApp, removeApp} from '../../fixtures/index.ts';
import {PLUGIN} from './cases.ts';
import {runMfTsc} from './commands.ts';
import type {BinReport} from './commands.ts';
import {locate, open, startTsserver} from './tsserver.ts';

export const BROKEN = 'types-broken';
export const VALID = 'types-every-target';
export const NOT_STRING = "Type 'number' is not assignable to type 'string'.";

type Report = BinReport<{projects: {tsconfig: string; files: number}[]}>;

const fixture = (app: string, file: string) => readFileSync(join(FIXTURES_DIR, 'apps', app, file), 'utf8');
export const report = (stdout: string) => JSON.parse(stdout) as Report;

/** 1-based columns of `needle` in `source`, `length` characters from `shift` past its start; never across a line. */
export function span(
  source: string,
  needle: string,
  length = needle.length,
  shift = 0
): Pick<Finding, 'line' | 'column' | 'end'> {
  const {line, offset} = locate(source, needle, shift);
  return {line, column: offset, end: {line, column: offset + length}};
}

export type Located = Pick<Finding, 'code' | 'line' | 'column' | 'end'>;

/** Each file's problems from mf-tsc and from tsserver, by default with our plugin from source. */
export async function bothHosts(
  root: string,
  files: string[],
  options: Omit<Parameters<typeof startTsserver>[0], 'cwd'> = {plugins: [PLUGIN]}
): Promise<{ours: Located[][]; theirs: Located[][]}> {
  const {findings} = report((await runMfTsc(root, [...files, '--format', 'json'])).stdout);
  const ours = files.map((name) =>
    findings.filter(({file}) => file === name).map(({code, line, column, end}) => ({code, line, column, end}))
  );
  const tsserver = startTsserver({cwd: root, ...options});
  try {
    const components = files.map((file) => ({filename: join(root, file), source: readFileSync(join(root, file), 'utf8')}));
    await open(tsserver, components);
    const theirs: Located[][] = [];
    for (const {filename} of components) {
      theirs.push(
        (await tsserver.diagnostics(filename)).map(({code, start, end}) => ({
          code: typeof code === 'number' ? `TS${code}` : String(code),
          line: start.line,
          column: start.offset,
          end: {line: end.line, column: end.offset},
        }))
      );
    }
    return {ours, theirs};
  } finally {
    await tsserver.stop();
  }
}

// The milestone 7 exit test's edit of fixtures Card.ucf: a number in a string attribute.
const SVELTE_PROPS = '    let { title }: { title: string } = $props()\n';
const SVELTE_HEADING = '<h2>{title}</h2></div>\n</svelte>';

export const breakSvelteMarkup = (card: string): string =>
  edited(
    edited(card, SVELTE_PROPS, `${SVELTE_PROPS}    const count: number = 1\n`),
    SVELTE_HEADING,
    SVELTE_HEADING.replace('<h2>', '<h2 title={count}>')
  );

export const line = ({file, line, column, code, framework, severity, message}: Finding) =>
  `${file}:${line}:${column}: ${severity} ${code}${framework ? ` (${framework})` : ''}: ${message}`;

const TO_FIXED = "Property 'toFixed' does not exist on type 'string'. Did you mean 'fixed'?";

function expected(file: string, needle: string, text: string, rest: Omit<Finding, 'file' | 'line' | 'column' | 'end'>) {
  const at = span(fixture(BROKEN, file), needle, text.length, needle.indexOf(text));
  return {finding: (shown = file): Finding => ({file: shown, ...at, ...rest}), text};
}

// TypeScript marks the prop whose value has the wrong type, and the member a target lacks.
export const BREAKS = expected('ReactBreaks.ucf', 'text={42}', 'text', {
  code: 'TS2322',
  severity: 'error',
  message: NOT_STRING,
  block: 'react',
  framework: 'react',
});
export const SVELTE_BREAKS = expected('SvelteBreaks.ucf', 'label.toFixed', 'toFixed', {
  code: 'TS2551',
  severity: 'error',
  message: TO_FIXED,
  block: 'svelte',
  framework: 'svelte',
});
export const VUE_BREAKS = expected('VueBreaks.ucf', 'label.toFixed', 'toFixed', {
  code: 'TS2551',
  severity: 'error',
  message: TO_FIXED,
  block: 'vue',
  framework: 'vue',
});
export const NO_SIZE = expected('main.ts', '{size}', 'size', {
  code: 'TS2614',
  severity: 'error',
  message:
    `Module '"./OnlyReactExport.ucf"' has no exported member 'size'. ` +
    `Did you mean to use 'import size from "./OnlyReactExport.ucf"' instead?`,
});
export const BAD_PAGE = expected('BadPage.vue', ':label="1"', 'label', {
  code: 'TS2322',
  severity: 'error',
  message: NOT_STRING,
});
export const MAIN = expected('pages/main.tsx', 'text={1}', 'text', {code: 'TS2322', severity: 'error', message: NOT_STRING});

/** A whole-project run's findings, in the order `mf-tsc` prints them. */
export const BROKEN_FINDINGS = [BAD_PAGE, BREAKS, SVELTE_BREAKS, VUE_BREAKS, NO_SIZE, MAIN];
export const BROKEN_FILES = 8;

export const fails = (message: string) => ({code: 2, stdout: '', stderr: `mf-tsc: ${message}\n`});

export async function withCopy(app: string, check: (root: string) => Promise<void>, copy = copyApp): Promise<void> {
  const root = await copy(app);
  try {
    await check(root);
  } finally {
    await removeApp(root);
  }
}

export function editFile(root: string, file: string, from: string, to: string): void {
  const path = join(root, file);
  writeFileSync(path, edited(readFileSync(path, 'utf8'), from, to));
}

export function addFile(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), {recursive: true});
  writeFileSync(join(root, file), text);
}

// What the host must not have for a test outside the repo to mean what it says.
function ancestors(dir: string): string[] {
  const dirs = [dir];
  while (dirs.at(-1) !== parse(dir).root) dirs.push(dirname(dirs.at(-1)!));
  return dirs;
}

export function assertNoConfigAbove(dir: string): void {
  const found = ancestors(dir).filter((folder) => existsSync(join(folder, 'tsconfig.json')));
  expect(found, 'a tsconfig.json above the temp folder changes what mf-tsc finds').toEqual([]);
}

/** Run the copy with `NODE_PATH` unset: Node also looks there. */
export function assertNotInstalled(dir: string, name: string): void {
  const globals = [join(homedir(), '.node_modules'), join(homedir(), '.node_libraries')];
  const folders = [...ancestors(dir).map((folder) => join(folder, 'node_modules')), ...globals];
  const found = folders.filter((folder) => existsSync(join(folder, name)));
  expect(found, `a ${name} install the temp copy can reach`).toEqual([]);
}

/** The repo's own typescript in `dir/node_modules`, and nothing else there. */
export function linkTypeScript(dir: string): void {
  const typescript = dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')));
  mkdirSync(join(dir, 'node_modules'), {recursive: true});
  symlinkSync(typescript, join(dir, 'node_modules', 'typescript'), 'junction');
}
