import {splitBlocks} from '@multifront/core';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {componentPath, readComponent} from '../fixtures/index.ts';
import {startTsserver} from './lib/tsserver.ts';
import type {Tsserver, TsDiagnostic} from './lib/tsserver.ts';

type Location = ts.server.protocol.Location;

const PROFILE = readComponent('editor/Profile.ucf');
const IMPORT_ERRORS = readComponent('editor/ImportErrors.ucf');

/** 1-based line and offset of `needle` (plus `shift` characters) in `source`, as tsserver counts. */
function locate(source: string, needle: string, shift = 0): Location {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`${needle} not found`);
  const before = source.slice(0, index + shift).split('\n');
  return {line: before.length, offset: before.at(-1)!.length + 1};
}

function lineOf(source: string, needle: string): number {
  return locate(source, needle).line;
}

function offsetOf(source: string, {line, offset}: Location): number {
  const lines = source.split('\n').slice(0, line - 1);
  return lines.reduce((sum, text) => sum + text.length + 1, 0) + offset - 1;
}

describe('imports inside a .ucf block, through tsserver with our plugin', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath('editor'), plugins: ['@multifront/language-tools/typescript-plugin']});
    await server.request('updateOpen', {
      openFiles: [PROFILE, IMPORT_ERRORS].map(({filename, source}) => ({file: filename, fileContent: source})),
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('Profile.ucf: hover on <Card shows its props', async () => {
    const at = locate(PROFILE.source, '<Card', 1);
    const info = await server.request<ts.server.protocol.QuickInfoResponseBody>('quickinfo', {
      file: PROFILE.filename,
      ...at,
    });
    expect(info.displayString.replace(/\s+/g, ' ')).toContain('{ title: string; }');
  });

  it("Profile.ucf: definition on Card lands in Card.ucf's <react> block", async () => {
    const card = readComponent('Card.ucf');
    const definitions = await server.request<ts.server.protocol.FileSpanWithContext[]>('definition', {
      file: PROFILE.filename,
      ...locate(PROFILE.source, '<Card', 1),
    });
    expect(definitions.map(({file}) => file)).toEqual([card.filename]);
    const react = splitBlocks(card.source, card.filename).targets.react!;
    const start = offsetOf(card.source, definitions[0]!.start);
    expect(start).toBeGreaterThanOrEqual(react.contentStart);
    expect(start).toBeLessThan(react.contentEnd);
  });

  it('Profile.ucf: both imports resolve, no diagnostics', async () => {
    expect(await server.diagnostics(PROFILE.filename)).toEqual([]);
  });

  describe('ImportErrors.ucf', () => {
    let diagnostics: TsDiagnostic[];
    const onLine = (needle: string) => diagnostics.filter(({start}) => start.line === lineOf(IMPORT_ERRORS.source, needle));

    beforeAll(async () => {
      diagnostics = await server.diagnostics(IMPORT_ERRORS.filename);
    });

    it('a missing title prop is an error on its line', () => {
      expect(onLine('<Card />').map(({code}) => code)).toEqual([2741]);
    });

    it('an import of a file without a <react> block names both files', () => {
      const [error, ...rest] = onLine('VueOnly.ucf');
      expect(rest).toEqual([]);
      expect(error).toMatchObject({code: 'missing-target-block', source: 'multifront', category: 'error'});
      expect(error!.text).toContain('VueOnly.ucf');
      expect(error!.text).toContain('ImportErrors.ucf');
    });

    it('a framework attribute inside <react> is framework-in-block', () => {
      const [error, ...rest] = onLine("with { framework: 'vue' }");
      expect(rest).toEqual([]);
      expect(error).toMatchObject({code: 'framework-in-block', source: 'multifront', category: 'error'});
      expect(error!.start).toEqual(locate(IMPORT_ERRORS.source, "'../Badge.ucf'"));
    });
  });
});
