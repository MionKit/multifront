// Format Document through the real server, with a tsdk as VS Code passes one: exactly what the real mf-fmt writes.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {findFormatConfig, formatUcf} from '@multifront/language-tools';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {edited} from '../../build/lib/library.ts';
import {copyApp, copyAppOutside, removeApp} from '../../fixtures/index.ts';
import {runMfFmt} from '../lib/commands.ts';
import {contents, copyOxfmtWithoutSvelte, LINT_FORMAT, LINT_FORMAT_SVELTE, MESSY, ORIGINAL, read} from '../lib/format.ts';
import {formatDocument, startLanguageServer, TSDK} from '../lib/lsp.ts';
import type {LanguageServer} from '../lib/lsp.ts';
import {assertNotInstalled} from '../lib/tsc.ts';

const MISSING_SVELTE =
  'multifront: oxfmt cannot load svelte/compiler, so <svelte> blocks stay as written; add svelte to devDependencies';
const noOxfmt = (root: string) =>
  `multifront: no formatting in ${root} (oxfmt is not installed in ${root}; add it to devDependencies)`;

type Copy = (name: string) => Promise<string>;

/** A server on one copy of `app`, and a second copy for the real `mf-fmt`. */
function formatting(app: string, copy: Copy = copyApp, prepare: (root: string) => void = () => {}) {
  const state = {root: '', other: '', server: undefined as unknown as LanguageServer};

  beforeAll(async () => {
    [state.root, state.other] = await Promise.all([copy(app), copy(app)]);
    prepare(state.root);
    prepare(state.other);
    state.server = await startLanguageServer(state.root, {initializationOptions: {typescript: {tsdk: TSDK}}});
  });

  afterAll(async () => {
    await state.server?.stop();
    await Promise.all([state.root, state.other].filter(Boolean).map((root) => removeApp(root)));
  });

  /** What the real `mf-fmt` writes for `text` as `Messy.ucf`; no `NODE_PATH`, as the server has none. */
  async function mfFmt(text: string): Promise<string> {
    writeFileSync(join(state.other, MESSY), text);
    const run = await runMfFmt(state.other, [MESSY], {NODE_PATH: undefined});
    expect({code: run.code, stderr: run.stderr}).toEqual({code: 0, stderr: ''});
    return read(state.other, MESSY);
  }

  const format = (text?: string, file = MESSY) => formatDocument(state.server, join(state.root, file), text);
  // Server warnings from `from` on: the log as a test sees it, in order.
  const warnings = (from = 0) =>
    state.server.log
      .slice(from)
      .filter(({type}) => type <= 2)
      .map(({message}) => message);

  return {state, mfFmt, format, warnings};
}

const wholeDocument = (text: string) => {
  const lines = text.split('\n');
  return {start: {line: 0, character: 0}, end: {line: lines.length - 1, character: lines.at(-1)!.length}};
};

describe('Format Document on lint-format/', () => {
  const {state, mfFmt, format, warnings} = formatting(LINT_FORMAT);

  it('gives byte for byte what the real mf-fmt writes, in one whole-document edit, and logs nothing', async () => {
    const expected = await mfFmt(ORIGINAL);
    expect(expected).not.toBe(ORIGINAL);
    const {edits, text} = await format(ORIGINAL);
    expect(text).toBe(expected);
    expect(edits).toEqual([{range: wholeDocument(ORIGINAL), newText: expected}]);
    expect(warnings()).toEqual([]);
  });

  it('gives no edits for a formatted file', async () => {
    expect((await format(await mfFmt(ORIGINAL))).edits).toEqual([]);
  });

  it('formats the unsaved buffer, not the file on disk', async () => {
    const unsaved = edited(ORIGINAL, 'const count=ref(0)', 'const count=ref(1);let other=2');
    const {text} = await format(unsaved);
    expect(text).toBe(await mfFmt(unsaved));
    expect(text).toContain('let other = 2');
  });

  it("gives no edits for a file the config's ignorePatterns exclude, as mf-fmt refuses one", async () => {
    const file = join(state.root, 'Lint.ucf');
    const source = read(state.root, 'Lint.ucf');
    expect((await formatUcf(file, source, findFormatConfig(file, state.root))).text).not.toBe(source);
    expect((await format(undefined, 'Lint.ucf')).edits).toEqual([]);
  });

  it('gives no edits and logs nothing when a block does not parse', async () => {
    const from = state.server.log.length;
    expect((await format(edited(ORIGINAL, 'setCount(count+1)', 'setCount(count+)'))).edits).toEqual([]);
    expect(warnings(from)).toEqual([]);
  });

  it('gives no edits for a range: neither our plugin nor any other service formats a selection', async () => {
    const document = await state.server.openTextDocument(join(state.root, MESSY), 'ucf');
    await format(ORIGINAL);
    const line = ORIGINAL.split('\n').indexOf('.messy{padding:$gap;  &:hover{opacity:.8}}');
    const range = {start: {line, character: 0}, end: {line: line + 1, character: 0}};
    const edits = await state.server.sendDocumentRangeFormattingRequestRequest(document.uri, range, {
      tabSize: 2,
      insertSpaces: true,
    });
    expect(edits ?? []).toEqual([]);
  });

  it("gives no edits for a config mf-fmt rejects, and logs mf-fmt's message once until a format succeeds", async () => {
    const config = read(state.root, '.oxfmtrc.json');
    for (const root of [state.root, state.other]) writeFileSync(join(root, '.oxfmtrc.json'), '{"semi": false');
    try {
      const run = await runMfFmt(state.other, [MESSY]);
      expect(run).toMatchObject({code: 2, stdout: ''});
      const message = run.stderr.replace(/^mf-fmt: /, '').trimEnd();
      expect(message).toMatch(/^\.oxfmtrc\.json: /);
      const from = state.server.log.length;
      expect((await format(ORIGINAL)).edits).toEqual([]);
      expect((await format(ORIGINAL)).edits).toEqual([]);
      expect(warnings(from)).toEqual([`multifront: no formatting in ${state.root} (${message})`]);
    } finally {
      for (const root of [state.root, state.other]) writeFileSync(join(root, '.oxfmtrc.json'), config);
    }
    expect((await format(ORIGINAL)).text).toBe(await mfFmt(ORIGINAL));
  });
});

describe('Format Document on lint-format-svelte/, which turns on the svelte option of oxfmt', () => {
  const {mfFmt, format, warnings} = formatting(LINT_FORMAT_SVELTE);

  it('gives what the real mf-fmt writes, the <svelte> block formatted too', async () => {
    const {text} = await format(ORIGINAL);
    expect(text).toBe(await mfFmt(ORIGINAL));
    expect(contents(text).svelte).not.toBe(contents(ORIGINAL).svelte);
    expect(warnings()).toEqual([]);
  });
});

describe('Format Document with no oxfmt in the project', () => {
  const {state, format, warnings} = formatting(LINT_FORMAT, copyAppOutside, (root) => assertNotInstalled(root, 'oxfmt'));

  it('gives no edits, logs one line, and the server keeps answering', async () => {
    expect((await format(ORIGINAL)).edits).toEqual([]);
    expect((await format(ORIGINAL)).edits).toEqual([]);
    expect(warnings()).toEqual([noOxfmt(state.root)]);
    const document = await state.server.openTextDocument(join(state.root, MESSY), 'ucf');
    expect(await state.server.sendDocumentDiagnosticRequest(document.uri)).toMatchObject({kind: 'full'});
    expect(state.server.process.exitCode).toBeNull();
  });
});

describe('Format Document when oxfmt cannot load svelte/compiler', () => {
  const {mfFmt, format, warnings} = formatting(LINT_FORMAT_SVELTE, copyAppOutside, (root) => {
    copyOxfmtWithoutSvelte(root);
    assertNotInstalled(root, 'svelte');
  });

  it('applies what mf-fmt writes, the <svelte> block as written, and logs one line', async () => {
    const {text} = await format(ORIGINAL);
    expect(text).toBe(await mfFmt(ORIGINAL));
    expect(text).not.toBe(ORIGINAL);
    expect(contents(text).svelte).toBe(contents(ORIGINAL).svelte);
    await format(ORIGINAL);
    expect(warnings()).toEqual([MISSING_SVELTE]);
  });
});
