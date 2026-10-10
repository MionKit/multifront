import {splitBlocks} from '@multifront/core';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {componentPath, readComponent} from '../fixtures/index.ts';
import {locate, offsetAt, startTsserver} from './lib/tsserver.ts';
import type {Tsserver, TsDiagnostic} from './lib/tsserver.ts';

type Definitions = ts.server.protocol.FileSpanWithContext[];

const PLUGIN = '@multifront/language-tools/typescript-plugin';
const CARD = readComponent('Card.ucf');
const PROFILE = readComponent('editor/Profile.ucf');
const IMPORT_ERRORS = readComponent('editor/ImportErrors.ucf');
const VUE_ONLY = readComponent('imports/VueOnly.ucf');

function expectInCardReact(definitions: Definitions): void {
  expect(definitions.map(({file}) => file)).toEqual([CARD.filename]);
  const react = splitBlocks(CARD.source, CARD.filename).targets.react!;
  const start = offsetAt(CARD.source, definitions[0]!.start);
  expect(start).toBeGreaterThanOrEqual(react.contentStart);
  expect(start).toBeLessThan(react.contentEnd);
}

describe('.ucf imports through tsserver with our plugin', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath('editor'), plugins: [PLUGIN]});
    const files = [PROFILE, IMPORT_ERRORS, VUE_ONLY];
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
