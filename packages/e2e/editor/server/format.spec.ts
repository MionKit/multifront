// Format Document through the real server, with a tsdk as VS Code passes one: exactly what the real mf-fmt writes.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {findFormatConfig, formatUcf} from '@multifront/language-tools';
import {describe, expect, it} from 'vitest';
import {edited} from '../../build/lib/library.ts';
import {copyAppOutside} from '../../fixtures/index.ts';
import {runMfFmt} from '../lib/commands.ts';
import {
  contents,
  copyOxfmtWithoutSvelte,
  formatting,
  LINT_FORMAT,
  LINT_FORMAT_SVELTE,
  MESSY,
  ORIGINAL,
  read,
} from '../lib/format.ts';
import {CLIENT_OPTIONS} from '../lib/lsp.ts';
import {assertNotInstalled} from '../lib/tsc.ts';

const MISSING_SVELTE =
  'multifront: oxfmt cannot load svelte/compiler, so <svelte> blocks stay as written; add svelte to devDependencies';
const noOxfmt = (root: string) =>
  `multifront: no formatting in ${root} (oxfmt is not installed in ${root}; add it to devDependencies)`;

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
    expect((await format(undefined, file)).edits).toEqual([]);
  });

  it('formats a file outside every workspace folder from its own folder, as mf-fmt run there', async () => {
    const expected = await mfFmt(ORIGINAL);
    expect((await format(ORIGINAL, join(state.other, MESSY))).text).toBe(expected);
  });

  it('gives no edits and logs nothing for an untitled document', async () => {
    const from = state.server.log.length;
    const document = await state.server.openUntitledDocument('ucf', ORIGINAL);
    expect((await state.server.sendDocumentFormattingRequest(document.uri, CLIENT_OPTIONS)) ?? []).toEqual([]);
    expect(warnings(from)).toEqual([]);
  });

  it('gives no edits and logs nothing when a block does not parse', async () => {
    const from = state.server.log.length;
    expect((await format(edited(ORIGINAL, 'setCount(count+1)', 'setCount(count+)'))).edits).toEqual([]);
    expect(warnings(from)).toEqual([]);
  });

  it('gives no edits for a range: neither our plugin nor any other service formats a selection', async () => {
    const {uri} = await state.server.openTextDocument(join(state.root, MESSY), 'ucf');
    await format(ORIGINAL);
    const line = ORIGINAL.split('\n').indexOf('.messy{padding:$gap;  &:hover{opacity:.8}}');
    const range = {start: {line, character: 0}, end: {line: line + 1, character: 0}};
    expect((await state.server.sendDocumentRangeFormattingRequestRequest(uri, range, CLIENT_OPTIONS)) ?? []).toEqual([]);
  });

  it("gives no edits for a config mf-fmt rejects, and logs mf-fmt's message once per reason until a format succeeds", async () => {
    const config = read(state.root, '.oxfmtrc.json');
    const setConfig = (text: string) => {
      for (const root of [state.root, state.other]) writeFileSync(join(root, '.oxfmtrc.json'), text);
    };
    const rejected = async (text: string) => {
      setConfig(text);
      const run = await runMfFmt(state.other, [MESSY]);
      expect(run).toMatchObject({code: 2, stdout: ''});
      return run.stderr.replace(/^mf-fmt: /, '').trimEnd();
    };
    const logged = (message: string) => `multifront: no formatting in ${state.root} (${message})`;
    const from = state.server.log.length;
    try {
      const notJson = await rejected('{"semi": false');
      expect(notJson).toMatch(/^\.oxfmtrc\.json: /);
      expect((await format(ORIGINAL)).edits).toEqual([]);
      expect((await format(ORIGINAL)).edits).toEqual([]);
      const notObject = await rejected('[]');
      expect(notObject).toBe('.oxfmtrc.json: not a JSON object');
      expect((await format(ORIGINAL)).edits).toEqual([]);
      setConfig(config);
      expect((await format(ORIGINAL)).text).toBe(await mfFmt(ORIGINAL));
      // The reason last logged, again after a successful format.
      await rejected('[]');
      expect((await format(ORIGINAL)).edits).toEqual([]);
      expect(warnings(from)).toEqual([logged(notJson), logged(notObject), logged(notObject)]);
    } finally {
      setConfig(config);
    }
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
  const {state, format, warnings} = formatting(LINT_FORMAT, {
    copy: copyAppOutside,
    prepare: (root) => assertNotInstalled(root, 'oxfmt'),
  });

  it('gives no edits, logs one line, and the server keeps answering', async () => {
    expect((await format(ORIGINAL)).edits).toEqual([]);
    expect((await format(ORIGINAL)).edits).toEqual([]);
    // A file the splitter rejects never reaches oxfmt: that is no successful format.
    expect((await format(`${ORIGINAL}<react lang="tsx">\n</react>\n`)).edits).toEqual([]);
    expect((await format(ORIGINAL)).edits).toEqual([]);
    expect(warnings()).toEqual([noOxfmt(state.root)]);
    const document = await state.server.openTextDocument(join(state.root, MESSY), 'ucf');
    expect(await state.server.sendDocumentDiagnosticRequest(document.uri)).toMatchObject({kind: 'full'});
    expect(state.server.process.exitCode).toBeNull();
  });
});

describe('Format Document when oxfmt cannot load svelte/compiler', () => {
  const {mfFmt, format, warnings} = formatting(LINT_FORMAT_SVELTE, {
    copy: copyAppOutside,
    prepare: (root) => {
      copyOxfmtWithoutSvelte(root);
      assertNotInstalled(root, 'svelte');
    },
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
