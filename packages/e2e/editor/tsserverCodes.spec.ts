// The codes the language server leaves to tsserver show once in the editor: tsserver's report, not ours.
import {checkBlocks, splitBlocks} from '@multifront/core';
import type {DiagnosticCode} from '@multifront/core';
import {TSSERVER_CODES} from '@multifront/language-tools';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {multifrontDiagnostics} from './lib/cases.ts';
import {open, startTsserver} from './lib/tsserver.ts';
import type {Component, Tsserver} from './lib/tsserver.ts';

const PLUGIN = '@multifront/language-tools/typescript-plugin';
const ATTR_IN_BLOCK = readComponent('react/errors/AttrInBlock.front');
const ATTR_NO_DEFAULT = readComponent('react/errors/AttrNoDefault.front');
const SYNTAX_ERROR = readComponent('react/errors/SyntaxError.front');

// 1-based, as tsserver's `start.line` is.
function linesOf({filename, source}: Component, code: DiagnosticCode): number[] {
  return checkBlocks(splitBlocks(source, filename))
    .filter((diagnostic) => diagnostic.code === code)
    .map(({line}) => line);
}

describe('react-syntax-error and framework-in-block, with tsserver and the language server both running', () => {
  let tsserver: Tsserver;
  let server: LanguageServer;

  beforeAll(async () => {
    tsserver = startTsserver({cwd: componentPath('react'), plugins: [PLUGIN]});
    await open(tsserver, [ATTR_IN_BLOCK, ATTR_NO_DEFAULT, SYNTAX_ERROR]);
    server = await startLanguageServer(join(FIXTURES_DIR, 'components'));
  });

  afterAll(async () => {
    await Promise.all([tsserver?.stop(), server?.stop()]);
  });

  async function serverCodes(filename: string) {
    const document = await server.openTextDocument(filename, 'front');
    return (await multifrontDiagnostics(server, document)).map(({code}) => code);
  }

  it('are the codes the language server leaves out', () => {
    expect([...TSSERVER_CODES].sort()).toEqual(['framework-in-block', 'react-syntax-error']);
  });

  it('AttrInBlock.front: one framework-in-block per attribute, from tsserver alone', async () => {
    const lines = linesOf(ATTR_IN_BLOCK, 'framework-in-block');
    expect(lines).toHaveLength(7);
    const fromTsserver = (await tsserver.diagnostics(ATTR_IN_BLOCK.filename))
      .filter(({code}) => String(code) === 'framework-in-block')
      .map(({start}) => start.line);
    expect(fromTsserver).toEqual(lines);
    expect(await serverCodes(ATTR_IN_BLOCK.filename)).toEqual([]);
  });

  it('AttrNoDefault.front: the server sends its other error, tsserver the framework-in-block', async () => {
    const fromTsserver = (await tsserver.diagnostics(ATTR_NO_DEFAULT.filename))
      .filter(({code}) => String(code) === 'framework-in-block')
      .map(({start}) => start.line);
    expect(fromTsserver).toEqual(linesOf(ATTR_NO_DEFAULT, 'framework-in-block'));
    expect(await serverCodes(ATTR_NO_DEFAULT.filename)).toEqual(['react-no-default-export']);
  });

  it('SyntaxError.front: the syntax error comes from tsserver alone, on its line', async () => {
    const [line] = linesOf(SYNTAX_ERROR, 'react-syntax-error');
    const syntactic = await tsserver.request<{start: {line: number}}[]>('syntacticDiagnosticsSync', {
      file: SYNTAX_ERROR.filename,
    });
    expect(syntactic.map(({start}) => start.line)).toContain(line);
    expect(await serverCodes(SYNTAX_ERROR.filename)).toEqual([]);
  });
});
