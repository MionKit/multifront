import {copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, FIXTURES_DIR, readComponent, removeApp} from '../../fixtures/index.ts';
import {jsonFindings, runMfFmt, runMfLint, runMfTsc} from '../lib/commands.ts';
import {read} from '../lib/format.ts';
import {addFile, breakSvelteMarkup, editFile, NOT_STRING, span} from '../lib/tsc.ts';
import {CRASH_DIR, reportChecks, runInVsCode, VSCODE_VERSION} from '../lib/vscode.ts';
import type {Check} from '../lib/vscode.ts';
import {packVsix, VSIX_FILE} from '../lib/vsix.ts';

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
const CARD = 'Card.front';
const VUE_PROPS = 'defineProps<{ title: string }>();\n';
const projects: string[] = [];

afterAll(async () => {
  for (const root of projects) await removeApp(root);
});

/** Fixtures Card.front in a copy of card-project: tsconfig, `.oxlintrc.json`, `.oxfmtrc.json`. */
async function cardProject(): Promise<string> {
  const root = await copyApp('card-project');
  projects.push(root);
  addFile(root, CARD, readComponent(CARD).source);
  return root;
}

function breakCard(root: string): void {
  addFile(root, CARD, breakSvelteMarkup(read(root, CARD)));
  editFile(root, CARD, VUE_PROPS, `${VUE_PROPS}  debugger;\n`);
}

describe('milestone 7 exit test: Card.front through mf-tsc, mf-lint and mf-fmt', () => {
  it('1. mf-tsc, mf-lint and mf-fmt --check all exit 0 on the copy', async () => {
    const root = await cardProject();
    const runs = await Promise.all([runMfTsc(root), runMfLint(root), runMfFmt(root, ['--check'])]);
    expect(runs.map(({code, stdout, stderr}) => ({code, stdout, stderr}))).toEqual([
      {code: 0, stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n', stderr: ''},
      {code: 0, stdout: 'mf-lint: linted 1 file: no problems\n', stderr: ''},
      {code: 0, stdout: 'mf-fmt: 0 of 1 files not formatted\n', stderr: ''},
    ]);
  });

  it('2. a number in <svelte> fails mf-tsc inside that block, a debugger in <vue> is no-debugger at its line', async () => {
    const root = await cardProject();
    breakCard(root);
    const svelteLine = span(read(root, CARD), '<h2 title={count}>').line;
    const vueLine = span(read(root, CARD), '  debugger;').line;
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

describe('milestone 7 exit test: a real VS Code with the packed .vsix installed, on the same Card.front', () => {
  reportChecks(fullEditorChecks, async () => {
    const [workspace, other] = await Promise.all([cardProject(), cardProject()]);
    for (const root of [workspace, other]) breakCard(root);
    const [tsc, lint, fmt] = await Promise.all([
      jsonFindings(runMfTsc(workspace, [CARD, '--format', 'json'])),
      jsonFindings(runMfLint(workspace, [CARD, '--format', 'json'])),
      runMfFmt(other, [CARD]),
    ]);
    expect({code: fmt.code, stderr: fmt.stderr}).toEqual({code: 0, stderr: ''});
    // Check 5 imports step 7.5's Icon.front from the unsaved Card.front buffer.
    copyFileSync(join(FIXTURES_DIR, 'apps', 'svelte-markup', 'Icon.front'), join(workspace, 'Icon.front'));
    const vsix = join(temp, VSIX_FILE);
    return runInVsCode({vsix, workspace, suite: FULL_EDITOR, data: {tsc, lint, formatted: read(other, CARD)}});
  });
});
