import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {componentPath, readComponent} from '../fixtures/index.ts';
import {inBlock, locate, open, startTsserver} from './lib/tsserver.ts';
import type {TsDefinitions, TsDiagnostic, Tsserver} from './lib/tsserver.ts';

const PLUGIN = '@multifront/language-tools/typescript-plugin';
const CARD = readComponent('Card.front');
const PROFILE = readComponent('editor/Profile.front');
const IMPORT_ERRORS = readComponent('editor/ImportErrors.front');
const VUE_ONLY = readComponent('imports/VueOnly.front');

describe('.front imports through tsserver with our plugin', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath('editor'), plugins: [PLUGIN]});
    await open(server, [PROFILE, IMPORT_ERRORS, VUE_ONLY]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('Profile.front: hover on <Card shows its props', async () => {
    const info = await server.request<ts.server.protocol.QuickInfoResponseBody>('quickinfo', {
      file: PROFILE.filename,
      ...locate(PROFILE.source, '<Card', 1),
    });
    expect(info.displayString.replace(/\s+/g, ' ')).toContain('{ title: string; }');
  });

  it("Profile.front: definition on Card lands in Card.front's <react> block", async () => {
    const at = locate(PROFILE.source, '<Card', 1);
    const definitions = await server.request<TsDefinitions>('definition', {file: PROFILE.filename, ...at});
    expect(definitions).toHaveLength(1);
    expect(inBlock(CARD, 'react', definitions[0]!)).toBe(true);
  });

  it('Profile.front: both imports resolve, no diagnostics', async () => {
    expect(await server.diagnostics(PROFILE.filename)).toEqual([]);
  });

  it('a .front file without a <react> block is no TSX to tsserver: no diagnostics', async () => {
    expect(await server.diagnostics(VUE_ONLY.filename)).toEqual([]);
  });

  describe('ImportErrors.front', () => {
    let diagnostics: TsDiagnostic[];
    const onLine = (needle: string) => diagnostics.filter(({start}) => start.line === locate(IMPORT_ERRORS.source, needle).line);

    beforeAll(async () => {
      diagnostics = await server.diagnostics(IMPORT_ERRORS.filename);
    });

    it('a missing title prop is an error on its line', () => {
      expect(onLine('<Card />').map(({code}) => code)).toEqual([2741]);
    });

    it.each(["import VueOnly from '../imports/VueOnly.front'", "export { default as Again } from '../imports/VueOnly.front'"])(
      '%s: missing-target-block names both files, and is the only error',
      (needle) => {
        const [error, ...rest] = onLine(needle);
        expect(rest).toEqual([]);
        expect(error).toMatchObject({code: 'missing-target-block', source: 'multifront', category: 'error'});
        expect(error!.text).toBe('../imports/VueOnly.front has no <react> block; ImportErrors.front imports it as react');
      }
    );

    it.each([
      "import Badge from '../Badge.front' with { framework: 'vue' }",
      "import('../Badge.front', { with: { framework: 'vue' } })",
    ])('%s: framework-in-block at the specifier, and the only error', (needle) => {
      const [error, ...rest] = onLine(needle);
      expect(rest).toEqual([]);
      expect(error).toMatchObject({code: 'framework-in-block', source: 'multifront', category: 'error'});
      expect(error!.start).toEqual(locate(IMPORT_ERRORS.source, needle, needle.indexOf("'../Badge.front'")));
    });

    it('the framework-in-block import stays unresolved: Badge has no definition', async () => {
      const at = locate(IMPORT_ERRORS.source, '<Badge', 1);
      const definitions = await server.request<TsDefinitions>('definition', {file: IMPORT_ERRORS.filename, ...at});
      expect(definitions.map(({file}) => file)).not.toContain(componentPath('Badge.front'));
    });

    it("a .front file that does not exist keeps TypeScript's own error", () => {
      expect(onLine("import Gone from '../Gone.front'").map(({code}) => code)).toEqual([2307]);
    });
  });

  it('an unsaved edit that adds the <react> block resolves the import at once', async () => {
    const end = locate(VUE_ONLY.source, '</vue>', '</vue>'.length);
    const newText = '\n<react lang="tsx">\n  export default function VueOnly() { return <p /> }\n</react>';
    await server.request('updateOpen', {
      changedFiles: [{fileName: VUE_ONLY.filename, textChanges: [{start: end, end, newText}]}],
    });
    const diagnostics = await server.diagnostics(IMPORT_ERRORS.filename);
    const line = locate(IMPORT_ERRORS.source, "import VueOnly from '../imports/VueOnly.front'").line;
    expect(diagnostics.filter(({start}) => start.line === line)).toEqual([]);
  });
});
