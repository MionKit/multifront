import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Finding} from '@multifront/core';
import {componentPath, FIXTURES_DIR, TMP_DIR} from '../../fixtures/index.ts';
import {runMfFmt, runMfLint, runMfTsc} from '../lib/commands.ts';
import type {BinReport, BinRun} from '../lib/commands.ts';
import {read} from '../lib/format.ts';
import {editFile, NOT_STRING} from '../lib/tsc.ts';
import {CRASH_DIR, reportChecks, runInVsCode, VSCODE_VERSION} from '../lib/vscode.ts';
import type {Check} from '../lib/vscode.ts';
import {packVsix} from '../lib/vsix.ts';

const SUITE = join(import.meta.dirname, 'suite.cjs');
const FONTCONFIG_SUITE = join(import.meta.dirname, 'fontconfig.cjs');
const WORKSPACE = join(FIXTURES_DIR, 'apps', 'imports');
const require = createRequire(import.meta.url);
const {checks, withoutTypescript, TYPESCRIPT_EXTENSION} = require(SUITE) as {
  checks: Check[];
  withoutTypescript: Check[];
  TYPESCRIPT_EXTENSION: string;
};
const {checks: fontconfigChecks} = require(FONTCONFIG_SUITE) as {checks: Check[]};

let temp: string;
let extension: string;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-exit-'));
  extension = await packVsix(temp);
}, 120_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

describe(`milestone 2 exit test, in VS Code ${VSCODE_VERSION} with the packed extension`, () => {
  reportChecks(checks, () => runInVsCode({extension, workspace: WORKSPACE, suite: SUITE}));
});

describe("with VS Code's TypeScript extension disabled, the extension still starts its server", () => {
  reportChecks(withoutTypescript, () =>
    runInVsCode({
      extension,
      workspace: WORKSPACE,
      suite: join(import.meta.dirname, 'withoutTypescript.cjs'),
      args: ['--disable-extension', TYPESCRIPT_EXTENSION],
    })
  );
});

describe.runIf(process.platform === 'linux')("VS Code's main process reads the harness's one-file font config", () => {
  reportChecks(fontconfigChecks, () => runInVsCode({extension, workspace: WORKSPACE, suite: FONTCONFIG_SUITE}));
});

describe('a VS Code that dies by SIGSEGV', () => {
  const leftovers: string[] = [];
  const hostOptions = process.env.NODE_OPTIONS;

  afterAll(() => {
    process.env.NODE_OPTIONS = hostOptions;
    for (const path of leftovers) rmSync(path, {recursive: true, force: true});
  });

  async function crash(suiteFile: string): Promise<string> {
    const suite = join(import.meta.dirname, suiteFile);
    const error = await runInVsCode({extension, workspace: WORKSPACE, suite}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Test run terminated with signal SIGSEGV');
    return message;
  }

  /** Shares its name with the run's temp folder. */
  function keptDumps(message: string): string {
    const kept = /^crash dump kept in (.+)$/m.exec(message)?.[1];
    expect(kept, message.slice(0, 2000)).toBeDefined();
    leftovers.push(kept!);
    expect(kept!.startsWith(CRASH_DIR)).toBe(true);
    expect(readdirSync(kept!).some((name) => name.endsWith('.dmp'))).toBe(true);
    return kept!;
  }

  it('leaves its crash dump, named in the error, and got no NODE_OPTIONS', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    const message = await crash('crash.cjs');
    // The error ends with VS Code's own startup log: Electron names a NODE_OPTIONS it was given.
    expect(message).not.toContain('Most NODE_OPTIONs are not supported');
    // crash.cjs's writer would recreate the folder had the harness not waited for it.
    expect(existsSync(join(tmpdir(), basename(keptDumps(message))))).toBe(false);
  });

  it('kills a leftover process that outlives the wait, then deletes the folder', async () => {
    const message = await crash('crashStuck.cjs');
    const temp = join(tmpdir(), basename(keptDumps(message)));
    expect(message).not.toContain('temp folder not removed');
    // The writer recreates the folder every 10 ms while alive.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(temp)).toBe(false);
  });

  it('adds a failed cleanup step to the error, never in its place, and still deletes the folder', async () => {
    const message = await crash('crashBlocked.cjs');
    const blocked = /^crash dump not kept: .*'(.+)'/m.exec(message)?.[1];
    expect(blocked, message.slice(0, 2000)).toBeDefined();
    leftovers.push(blocked!);
    expect(existsSync(join(tmpdir(), basename(blocked!)))).toBe(false);
  });
});

const FULL_EDITOR = join(import.meta.dirname, 'fullEditor.cjs');
const {checks: fullEditorChecks} = createRequire(import.meta.url)(FULL_EDITOR) as {checks: Check[]};
const CARD = 'Card.ucf';
const TSCONFIG = {
  compilerOptions: {
    target: 'es2022',
    module: 'preserve',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    plugins: [{name: '@multifront/language-tools/typescript-plugin', framework: 'react'}],
  },
  include: ['*.ucf'],
};
// The only edits: a number passed to a string prop in <svelte>, a debugger in the <vue> script.
const SVELTE_PROPS = '    let { title }: { title: string } = $props()\n';
const SVELTE_HEADING = '<h2>{title}</h2></div>\n</svelte>';
const VUE_PROPS = 'defineProps<{ title: string }>();\n';

/** Card.ucf of the fixtures in a small project of its own, under the repo's `.tmp/` so its tools resolve. */
function cardProject(): string {
  mkdirSync(TMP_DIR, {recursive: true});
  const root = mkdtempSync(join(TMP_DIR, 'm7-exit-'));
  copyFileSync(componentPath(CARD), join(root, CARD));
  writeFileSync(join(root, '.oxlintrc.json'), '{"rules": {"no-debugger": "error"}}\n');
  writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
  writeFileSync(join(root, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  return root;
}

function breakCard(root: string): void {
  editFile(root, CARD, SVELTE_PROPS, `${SVELTE_PROPS}    const count: number = 1\n`);
  editFile(root, CARD, SVELTE_HEADING, SVELTE_HEADING.replace('<h2>', '<h2 title={count}>'));
  editFile(root, CARD, VUE_PROPS, `${VUE_PROPS}  debugger;\n`);
}

const lineOf = (root: string, needle: string) => read(root, CARD).slice(0, read(root, CARD).indexOf(needle)).split('\n').length;

async function jsonFindings(run: Promise<BinRun>): Promise<Finding[]> {
  const {code, stdout, stderr} = await run;
  expect({code, stderr}).toEqual({code: 1, stderr: ''});
  return (JSON.parse(stdout) as BinReport<object>).findings;
}

describe('milestone 7 exit test: Card.ucf through mf-tsc, mf-lint and mf-fmt', () => {
  const roots: string[] = [];
  const project = () => {
    const root = cardProject();
    roots.push(root);
    return root;
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, {recursive: true, force: true});
  });

  it('1. mf-tsc, mf-lint and mf-fmt --check all exit 0 on the copy', async () => {
    const root = project();
    const runs = await Promise.all([runMfTsc(root), runMfLint(root), runMfFmt(root, ['--check'])]);
    expect(runs.map(({code, stdout, stderr}) => ({code, stdout, stderr}))).toEqual([
      {code: 0, stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n', stderr: ''},
      {code: 0, stdout: 'mf-lint: linted 1 file: no problems\n', stderr: ''},
      {code: 0, stdout: 'mf-fmt: 0 of 1 files not formatted\n', stderr: ''},
    ]);
  });

  it('2. a number in <svelte> fails mf-tsc inside that block, a debugger in <vue> is no-debugger at its line', async () => {
    const root = project();
    breakCard(root);
    const svelteLine = lineOf(root, '<h2 title={count}>');
    const vueLine = lineOf(root, '  debugger;');
    const tsc = await jsonFindings(runMfTsc(root, ['--format', 'json']));
    expect(tsc).toEqual([
      expect.objectContaining({file: CARD, line: svelteLine, code: 'TS2322', message: NOT_STRING, block: 'svelte'}),
    ]);
    const lint = await jsonFindings(runMfLint(root, ['--format', 'json']));
    expect(lint).toEqual([expect.objectContaining({file: CARD, line: vueLine, code: 'eslint(no-debugger)', block: 'vue'})]);
    // The agent's view of the same.
    const svelte = await jsonFindings(runMfTsc(root, [CARD, '--framework', 'svelte', '--format', 'json']));
    expect(svelte).toEqual(tsc);
    expect(svelte[0]).toMatchObject({block: 'svelte', framework: 'svelte'});
    expect(await runMfTsc(root, [CARD, '--framework', 'react'])).toMatchObject({code: 0, stderr: ''});
    expect(await jsonFindings(runMfLint(root, [CARD, '--format', 'json']))).toEqual(lint);
  });
});

describe('milestone 7 exit test: a real VS Code with the packed .vsix installed, on the same Card.ucf', () => {
  let workspace: string | undefined;
  let other: string | undefined;

  afterAll(() => {
    for (const root of [workspace, other]) if (root) rmSync(root, {recursive: true, force: true});
  });

  reportChecks(fullEditorChecks, async () => {
    workspace = cardProject();
    other = cardProject();
    for (const root of [workspace, other]) breakCard(root);
    const [tsc, lint, fmt] = await Promise.all([
      jsonFindings(runMfTsc(workspace, [CARD, '--format', 'json'])),
      jsonFindings(runMfLint(workspace, [CARD, '--format', 'json'])),
      runMfFmt(other, [CARD]),
    ]);
    expect({code: fmt.code, stderr: fmt.stderr}).toEqual({code: 0, stderr: ''});
    // 5.: the Icon.ucf of step 7.5 next to the copy; the suite imports it in the unsaved buffer.
    copyFileSync(join(FIXTURES_DIR, 'apps', 'svelte-markup', 'Icon.ucf'), join(workspace, 'Icon.ucf'));
    const vsix = join(
      temp,
      readdirSync(temp).find((name) => name.endsWith('.vsix'))!
    );
    return runInVsCode({vsix, workspace, suite: FULL_EDITOR, data: {tsc, lint, formatted: read(other, CARD)}});
  });
});
