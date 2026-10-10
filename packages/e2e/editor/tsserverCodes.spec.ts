// The codes the language server leaves to tsserver show once in the editor: tsserver's report, not ours.
import {checkBlocks, splitBlocks} from '@multifront/core';
import type {DiagnosticCode} from '@multifront/core';
import {TSSERVER_CODES} from '@multifront/language-tools';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {open, startTsserver} from './lib/tsserver.ts';
import type {Tsserver} from './lib/tsserver.ts';

const PLUGIN = '@multifront/language-tools/typescript-plugin';
const ATTR_IN_BLOCK = readComponent('react/errors/AttrInBlock.ucf');
const SYNTAX_ERROR = readComponent('react/errors/SyntaxError.ucf');

// The 1-based lines where checkBlocks reports `code`.
function linesOf({filename, source}: {filename: string; source: string}, code: DiagnosticCode): number[] {
  return checkBlocks(splitBlocks(source, filename))
    .filter((diagnostic) => diagnostic.code === code)
    .map(({line}) => line);
}

describe('react-syntax-error and framework-in-block, with tsserver and the language server both running', () => {
  let tsserver: Tsserver;
  let server: LanguageServer;

  beforeAll(async () => {
    tsserver = startTsserver({cwd: componentPath('react'), plugins: [PLUGIN]});
    await open(tsserver, [ATTR_IN_BLOCK, SYNTAX_ERROR]);
    server = await startLanguageServer(join(FIXTURES_DIR, 'components'));
  });

  afterAll(async () => {
    await Promise.all([tsserver?.stop(), server?.stop()]);
  });

  async function serverCodes(filename: string) {
    const document = await server.openTextDocument(filename, 'ucf');
    const report = await server.sendDocumentDiagnosticRequest(document.uri);
    return ('items' in report ? report.items : []).filter(({source}) => source === 'multifront').map(({code}) => code);
  }

  it('are the codes the language server leaves out', () => {
    expect([...TSSERVER_CODES].sort()).toEqual(['framework-in-block', 'react-syntax-error']);
  });

  it('AttrInBlock.ucf: one framework-in-block per attribute, from tsserver alone', async () => {
    const lines = linesOf(ATTR_IN_BLOCK, 'framework-in-block');
    expect(lines).toHaveLength(6);
    const fromTsserver = (await tsserver.diagnostics(ATTR_IN_BLOCK.filename))
      .filter(({code}) => String(code) === 'framework-in-block')
      .map(({start}) => start.line);
    expect(fromTsserver).toEqual(lines);
    expect(await serverCodes(ATTR_IN_BLOCK.filename)).toEqual([]);
  });

  it('SyntaxError.ucf: the syntax error comes from tsserver alone, on its line', async () => {
    const [line] = linesOf(SYNTAX_ERROR, 'react-syntax-error');
    const syntactic = await tsserver.request<{start: {line: number}}[]>('syntacticDiagnosticsSync', {
      file: SYNTAX_ERROR.filename,
    });
    expect(syntactic.map(({start}) => start.line)).toContain(line);
    expect(await serverCodes(SYNTAX_ERROR.filename)).toEqual([]);
  });
});
