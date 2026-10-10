import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {splitBlocks} from '@multifront/core';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {startTsserver} from './lib/tsserver.ts';
import type {Tsserver, TsDiagnostic} from './lib/tsserver.ts';

type Location = ts.server.protocol.Location;
type Definitions = ts.server.protocol.FileSpanWithContext[];

const PLUGIN = '@multifront/language-tools/typescript-plugin';
const CARD = readComponent('Card.ucf');
const PROFILE = readComponent('editor/Profile.ucf');
const IMPORT_ERRORS = readComponent('editor/ImportErrors.ucf');
const VUE_ONLY = readComponent('imports/VueOnly.ucf');

function readApp(file: string): {filename: string; source: string} {
  const filename = join(FIXTURES_DIR, 'apps', 'imports', file);
  return {filename, source: readFileSync(filename, 'utf8')};
}

const APP = readApp('src/App.tsx');
const REEXPORT = readApp('src/reexport.ts');

/** 1-based line and offset of `needle` (plus `shift` characters) in `source`, as tsserver counts. */
function locate(source: string, needle: string, shift = 0): Location {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`${needle} not found`);
  const before = source.slice(0, index + shift).split('\n');
  return {line: before.length, offset: before.at(-1)!.length + 1};
}

/** The definition lands inside Card.ucf's `<react>` content, from the real splitter. */
function expectInCardReact(definitions: Definitions): void {
  expect(definitions.map(({file}) => file)).toEqual([CARD.filename]);
  const react = splitBlocks(CARD.source, CARD.filename).targets.react!;
  const {line, offset} = definitions[0]!.start;
  const start =
    CARD.source
      .split('\n')
      .slice(0, line - 1)
      .reduce((sum, text) => sum + text.length + 1, 0) +
    offset -
    1;
  expect(start).toBeGreaterThanOrEqual(react.contentStart);
  expect(start).toBeLessThan(react.contentEnd);
}

describe('.ucf imports through tsserver with our plugin', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath('editor'), plugins: [PLUGIN]});
    const files = [PROFILE, IMPORT_ERRORS, VUE_ONLY, APP, REEXPORT];
    await server.request('updateOpen', {openFiles: files.map(({filename, source}) => ({file: filename, fileContent: source}))});
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('Profile.ucf: hover on <Card shows its props', async () => {
    const info = await server.request<ts.server.protocol.QuickInfoResponseBody>('quickinfo', {
      file: PROFILE.filename,
      ...locate(PROFILE.source, '<Card', 1),
    });
    expect(info.displayString.replace(/\s+/g, ' ')).toContain('{ title: string; }');
  });

  it("Profile.ucf: definition on Card lands in Card.ucf's <react> block", async () => {
    const at = locate(PROFILE.source, '<Card', 1);
    expectInCardReact(await server.request<Definitions>('definition', {file: PROFILE.filename, ...at}));
  });

  it('Profile.ucf: both imports resolve, no diagnostics', async () => {
    expect(await server.diagnostics(PROFILE.filename)).toEqual([]);
  });

  it('a .ucf file without a <react> block is no TSX to tsserver: no diagnostics', async () => {
    expect(await server.diagnostics(VUE_ONLY.filename)).toEqual([]);
  });

  describe('ImportErrors.ucf', () => {
    let diagnostics: TsDiagnostic[];
    const onLine = (needle: string) => diagnostics.filter(({start}) => start.line === locate(IMPORT_ERRORS.source, needle).line);

    beforeAll(async () => {
      diagnostics = await server.diagnostics(IMPORT_ERRORS.filename);
    });

    it('a missing title prop is an error on its line', () => {
      expect(onLine('<Card />').map(({code}) => code)).toEqual([2741]);
    });

    it.each(["import VueOnly from '../imports/VueOnly.ucf'", "export { default as Again } from '../imports/VueOnly.ucf'"])(
      '%s: missing-target-block names both files, and is the only error',
      (needle) => {
        const [error, ...rest] = onLine(needle);
        expect(rest).toEqual([]);
        expect(error).toMatchObject({code: 'missing-target-block', source: 'multifront', category: 'error'});
        expect(error!.text).toBe('../imports/VueOnly.ucf has no <react> block; ImportErrors.ucf imports it as react');
      }
    );

    it.each([
      "import Badge from '../Badge.ucf' with { framework: 'vue' }",
      "import('../Badge.ucf', { with: { framework: 'vue' } })",
    ])('%s: framework-in-block at the specifier, and the only error', (needle) => {
      const [error, ...rest] = onLine(needle);
      expect(rest).toEqual([]);
      expect(error).toMatchObject({code: 'framework-in-block', source: 'multifront', category: 'error'});
      expect(error!.start).toEqual(locate(IMPORT_ERRORS.source, needle, needle.indexOf("'../Badge.ucf'")));
    });

    it('the framework-in-block import stays unresolved: Badge has no definition', async () => {
      const at = locate(IMPORT_ERRORS.source, '<Badge', 1);
      const definitions = await server.request<Definitions>('definition', {file: IMPORT_ERRORS.filename, ...at});
      expect(definitions.map(({file}) => file)).not.toContain(componentPath('Badge.ucf'));
    });

    it("a .ucf file that does not exist keeps TypeScript's own error", () => {
      expect(onLine("import Gone from '../Gone.ucf'").map(({code}) => code)).toEqual([2307]);
    });
  });

  describe('.ts and .tsx importers in the same program', () => {
    it('App.tsx (react by its extension): definition on <Card lands in Card.ucf, no diagnostics', async () => {
      const at = locate(APP.source, '<Card', 1);
      expectInCardReact(await server.request<Definitions>('definition', {file: APP.filename, ...at}));
      expect(await server.diagnostics(APP.filename)).toEqual([]);
    });

    it('reexport.ts (vue by its attribute): unresolved, no types yet, no error of ours', async () => {
      const diagnostics = await server.diagnostics(REEXPORT.filename);
      expect(diagnostics.map(({code, source}) => [code, source])).toEqual([[2307, undefined]]);
    });
  });

  it('an unsaved edit that adds the <react> block resolves the import at once', async () => {
    const end = locate(VUE_ONLY.source, '</vue>', '</vue>'.length);
    const newText = '\n<react>\n  export default function VueOnly() { return <p /> }\n</react>';
    await server.request('updateOpen', {
      changedFiles: [{fileName: VUE_ONLY.filename, textChanges: [{start: end, end, newText}]}],
    });
    const diagnostics = await server.diagnostics(IMPORT_ERRORS.filename);
    const line = locate(IMPORT_ERRORS.source, "import VueOnly from '../imports/VueOnly.ucf'").line;
    expect(diagnostics.filter(({start}) => start.line === line)).toEqual([]);
  });
});
