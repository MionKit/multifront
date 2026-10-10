import {readFileSync} from 'node:fs';
import {copyFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {splitBlocks} from '@multifront/core';
import type {TargetRule} from '@multifront/core';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EXPECTED_IMPORTS} from '../fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR, readComponent} from '../fixtures/index.ts';
import {locate, offsetAt, startTsserver} from './lib/tsserver.ts';
import type {TsDiagnostic, TsLocation, Tsserver} from './lib/tsserver.ts';

type Definitions = ts.server.protocol.FileSpanWithContext[];
type QuickInfo = ts.server.protocol.QuickInfoResponseBody;
type Completions = ts.server.protocol.CompletionInfo;
interface Component {
  filename: string;
  source: string;
}

const PLUGIN = '@multifront/language-tools/typescript-plugin';
const APP_DIR = join(FIXTURES_DIR, 'apps', 'imports');
const CARD = readComponent('Card.ucf');
const TYPE_ERROR = readComponent('editor/TypeError.ucf');
// The rows TypeScript itself reads; .vue, .svelte and .jsx importers come with M4 and M6.
const ROWS = EXPECTED_IMPORTS.filter(({file}) => /\.tsx?$/.test(file) && file !== 'src/mixed.ts');
const RULE_REASON: Record<TargetRule, string> = {
  block: 'the block it sits in',
  attribute: 'its framework attribute',
  importer: "the importer's extension",
  default: 'the default framework',
};
const STYLE_ACCESS = 'className={$style.';
const REACT_SIGNATURE = 'Card({ title }: { title: string })';

function readApp(file: string): Component {
  const filename = join(APP_DIR, file);
  return {filename, source: readFileSync(filename, 'utf8')};
}

const APP = readApp('src/App.tsx');
const MIXED = readApp('src/mixed.ts');

/** The opening quote of `specifier` on `line`, where the plugin reports. */
function specifierAt(source: string, line: number, specifier: string): TsLocation {
  const column = source.split('\n')[line - 1]!.indexOf(`'${specifier}'`);
  if (column < 0) throw new Error(`${specifier} not on line ${line}`);
  return {line, offset: column + 1};
}

const onLine = (diagnostics: TsDiagnostic[], line: number) => diagnostics.filter(({start}) => start.line === line);

function inCardReact({file, start}: {file: string; start: TsLocation}): boolean {
  const react = splitBlocks(CARD.source, CARD.filename).targets.react!;
  const offset = offsetAt(CARD.source, start);
  return file === CARD.filename && offset >= react.contentStart && offset < react.contentEnd;
}

function open(server: Tsserver, files: Component[]): Promise<unknown> {
  return server.request('updateOpen', {openFiles: files.map(({filename, source}) => ({file: filename, fileContent: source}))});
}

/** An unsaved edit, as an editor sends it; resolves to the edit that puts the text back. */
async function edit(server: Tsserver, {filename, source}: Component, needle: string, newText: string) {
  const start = locate(source, needle);
  const end = locate(source, needle, needle.length);
  const change = (text: string, to: TsLocation) =>
    server.request('updateOpen', {changedFiles: [{fileName: filename, textChanges: [{start, end: to, newText: text}]}]});
  await change(newText, end);
  return () => change(needle, locate(source.replace(needle, newText), newText, newText.length));
}

describe('the TypeScript plugin in tsserver, on the imports app', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    const importers = [...new Set(ROWS.map(({file}) => file))].map(readApp);
    await open(server, [...importers, MIXED, CARD, TYPE_ERROR]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it.each(ROWS)('$file line $line: $expect', async (row) => {
    const {filename, source} = readApp(row.file);
    const at = specifierAt(source, row.line, row.specifier);
    const diagnostics = onLine(await server.diagnostics(filename), row.line);
    if (!('rule' in row)) {
      expect(diagnostics).toMatchObject([{code: row.expect, source: 'multifront', category: 'error', start: at}]);
    } else if (row.expect === 'react') {
      expect(diagnostics).toEqual([]);
      const definitions = await server.request<Definitions>('definition', {file: filename, line: at.line, offset: at.offset + 1});
      expect(definitions.map(({file}) => file)).toEqual([CARD.filename]);
    } else {
      expect(diagnostics).toMatchObject([{code: 'target-not-built', source: 'multifront', category: 'error', start: at}]);
      expect(diagnostics[0]!.text).toContain(`imported as ${row.expect} (by ${RULE_REASON[row.rule]})`);
    }
  });

  describe('App.tsx', () => {
    it('quickinfo on <Card shows its props', async () => {
      const info = await server.request<QuickInfo>('quickinfo', {file: APP.filename, ...locate(APP.source, '<Card', 1)});
      expect(info.displayString.replace(/\s+/g, ' ')).toContain('{ title: string; }');
    });

    it("definition on <Card lands in Card.ucf's <react> block", async () => {
      const at = locate(APP.source, '<Card', 1);
      const definitions = await server.request<Definitions>('definition', {file: APP.filename, ...at});
      expect(definitions).toHaveLength(1);
      expect(inCardReact(definitions[0]!)).toBe(true);
    });

    it('a wrong prop type is an error', async () => {
      const revert = await edit(server, APP, '"Hello"', '{1}');
      try {
        const diagnostics = await server.diagnostics(APP.filename);
        expect(onLine(diagnostics, locate(APP.source, '<Card').line).map(({code}) => code)).toEqual([2322]);
      } finally {
        await revert();
      }
      expect(await server.diagnostics(APP.filename)).toEqual([]);
    });
  });

  describe('mixed.ts: one specifier imported as vue, then as react', () => {
    it.each(['VueCard', 'ReactCard'])('%s gets the React types of the last import', async (name) => {
      const info = await server.request<QuickInfo>('quickinfo', {
        file: MIXED.filename,
        ...locate(MIXED.source, `import ${name}`, 7),
      });
      expect(info.displayString).toContain('title: string');
    });

    it('the second import has the warning naming the fix; the first only its own error', async () => {
      const diagnostics = await server.diagnostics(MIXED.filename);
      const [vue, react] = EXPECTED_IMPORTS.filter(({file}) => file === 'src/mixed.ts').map(({line}) => line);
      expect(onLine(diagnostics, vue!).map(({code}) => code)).toEqual(['target-not-built']);
      const [warning, ...rest] = onLine(diagnostics, react!);
      expect(rest).toEqual([]);
      expect(warning).toMatchObject({code: 'mixed-frameworks', source: 'multifront', category: 'warning'});
      expect(warning!.text).toContain('imported as vue and as react');
      expect(warning!.text).toContain('re-export file');
    });
  });

  describe("inside Card.ucf's <react>", () => {
    it('completion after $style. lists card', async () => {
      const at = locate(CARD.source, STYLE_ACCESS, STYLE_ACCESS.length);
      const completions = await server.request<Completions>('completionInfo', {file: CARD.filename, ...at});
      expect(completions.entries.map(({name}) => name)).toContain('card');
    });

    it('hover on title shows string', async () => {
      const info = await server.request<QuickInfo>('quickinfo', {file: CARD.filename, ...locate(CARD.source, '<h2>{title}', 5)});
      expect(info.displayString).toContain('title: string');
    });

    it('definition on $style.card lands on .card', async () => {
      const at = locate(CARD.source, STYLE_ACCESS, STYLE_ACCESS.length + 1);
      const definitions = await server.request<Definitions>('definition', {file: CARD.filename, ...at});
      expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
        {file: CARD.filename, start: locate(CARD.source, '.card {', 1)},
      ]);
    });

    it('TypeError.ucf reports its type error at its .ucf line and column', async () => {
      const diagnostics = await server.diagnostics(TYPE_ERROR.filename);
      expect(diagnostics).toMatchObject([{code: 2322, category: 'error', start: locate(TYPE_ERROR.source, 'label:')}]);
    });
  });

  describe('one program for .ucf and .tsx files', () => {
    it('an unsaved prop rename in Card.ucf makes App.tsx report the old prop at once', async () => {
      const revert = await edit(server, CARD, REACT_SIGNATURE, 'Card({ heading }: { heading: string })');
      try {
        const diagnostics = await server.diagnostics(APP.filename);
        expect(onLine(diagnostics, locate(APP.source, '<Card').line).map(({code}) => code)).toEqual([2322]);
      } finally {
        await revert();
      }
      expect(await server.diagnostics(APP.filename)).toEqual([]);
    });

    it('rename on the prop in Card.ucf also edits App.tsx', async () => {
      const at = locate(CARD.source, REACT_SIGNATURE, 'Card({ title }: { '.length + 1);
      const body = await server.request<ts.server.protocol.RenameResponseBody>('rename', {file: CARD.filename, ...at});
      expect(body.info.canRename).toBe(true);
      expect(body.locs.map(({file}) => file)).toEqual(expect.arrayContaining([CARD.filename, APP.filename]));
    });

    it('references from App.tsx list the use inside <react>', async () => {
      const at = locate(APP.source, 'title=', 1);
      const body = await server.request<ts.server.protocol.ReferencesResponseBody>('references', {file: APP.filename, ...at});
      expect(body.refs.some(inCardReact)).toBe(true);
    });
  });
});

describe('the TypeScript plugin in a project without @vue/compiler-sfc', () => {
  // Outside the repo on purpose: inside it, the root node_modules has the compiler.
  let dir: string;
  let server: Tsserver;
  let card: Component;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'multifront-no-vue-'));
    const compilerOptions = {jsx: 'preserve', module: 'preserve', moduleResolution: 'bundler', strict: true, noEmit: true};
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions, include: ['*.ucf']}));
    card = {filename: join(dir, 'Card.ucf'), source: CARD.source};
    await copyFile(CARD.filename, card.filename);
    server = startTsserver({cwd: dir, plugins: [PLUGIN]});
    await open(server, [card]);
  });

  afterAll(async () => {
    await server?.stop();
    if (dir) await rm(dir, {recursive: true, force: true});
  });

  it('still serves the <react> block, with $style typed loosely', async () => {
    const codes = (await server.diagnostics(card.filename)).map(({code}) => code);
    expect(codes).not.toContain(2304); // "Cannot find name '$style'": the raw file read as TSX
    expect(codes).not.toContain(2339);
    const info = await server.request<QuickInfo>('quickinfo', {file: card.filename, ...locate(card.source, '<h2>{title}', 5)});
    expect(info.displayString).toContain('title: string');
  });

  it('completion after $style. has no card: the scss module is not read', async () => {
    const at = locate(card.source, STYLE_ACCESS, STYLE_ACCESS.length);
    const completions = await server.request<Completions>('completionInfo', {file: card.filename, ...at});
    expect(completions.entries.map(({name}) => name)).not.toContain('card');
  });
});
