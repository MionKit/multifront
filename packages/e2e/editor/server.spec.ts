import {checkBlocks, splitBlocks} from '@multifront/core';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {componentPath, FIXTURES_DIR, listComponents, readComponent} from '../fixtures/index.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';

type Document = Awaited<ReturnType<LanguageServer['openTextDocument']>>;
type Range = Parameters<LanguageServer['sendInlayHintRequest']>[1];

const SEVERITY = {error: 1, warning: 2} as const;

let server: LanguageServer;

beforeAll(async () => {
  server = await startLanguageServer(join(FIXTURES_DIR, 'components'));
});

afterAll(async () => {
  await server?.stop();
});

function rangeOf(document: Document, start: number, end: number): Range {
  return {start: document.positionAt(start), end: document.positionAt(end)};
}

function byStart(first: {range: Range; code: unknown}, second: {range: Range; code: unknown}): number {
  const {start: firstStart} = first.range;
  const {start: secondStart} = second.range;
  const byLine = firstStart.line - secondStart.line;
  return byLine || firstStart.character - secondStart.character || String(first.code).localeCompare(String(second.code));
}

async function multifrontDiagnostics(document: Document) {
  const report = await server.sendDocumentDiagnosticRequest(document.uri);
  const items = 'items' in report ? report.items : [];
  const ours = items
    .filter(({source}) => source === 'multifront')
    .map(({code, severity, message, range}) => ({code, severity, message, range}));
  return ours.sort(byStart);
}

function expectedDiagnostics(document: Document, name: string) {
  const {filename, source} = readComponent(name);
  const expected = checkBlocks(splitBlocks(source, filename)).map(({code, severity, message, start, end}) => ({
    code,
    severity: SEVERITY[severity],
    message,
    range: rangeOf(document, start, end),
  }));
  return expected.sort(byStart);
}

describe('the language server serves <style> of Panel.ucf', () => {
  const {filename, source} = readComponent('Panel.ucf');
  const padding = source.indexOf('padding: $pad');

  it('completes a property name', async () => {
    const document = await server.openTextDocument(filename, 'ucf');
    const list = await server.sendCompletionRequest(document.uri, document.positionAt(padding + 2));
    expect(list?.items.map(({label}) => label)).toContain('padding');
  });

  it('hovers a property with its CSS docs, on its range in the .ucf file', async () => {
    const document = await server.openTextDocument(filename, 'ucf');
    const hover = await server.sendHoverRequest(document.uri, document.positionAt(padding + 2));
    expect(hover?.contents).toMatchObject({kind: 'markdown', value: expect.stringContaining('the padding area')});
    // The CSS service's range is the whole declaration.
    expect(hover?.range).toEqual(rangeOf(document, padding, padding + 'padding: $pad'.length));
  });

  it('goes from a scss variable to its declaration', async () => {
    const document = await server.openTextDocument(filename, 'ucf');
    const use = padding + 'padding: '.length;
    const result = await server.sendDefinitionRequest(document.uri, document.positionAt(use + 1));
    // The CSS service's target is the whole declaration.
    const declaration = '$pad: 1rem';
    const at = source.indexOf(declaration);
    expect(result).toEqual([{uri: document.uri, range: rangeOf(document, at, at + declaration.length)}]);
  });
});

describe('the language server reports checkBlocks on the .ucf file', () => {
  it.each(listComponents('invalid'))('%s', async (name) => {
    const document = await server.openTextDocument(componentPath(name), 'ucf');
    expect(await multifrontDiagnostics(document)).toEqual(expectedDiagnostics(document, name));
  });

  it('reports on an unsaved buffer too (an untitled: URI, not a file)', async () => {
    const name = 'invalid/DuplicateReact.ucf';
    const document = await server.openUntitledDocument('ucf', readComponent(name).source);
    const ours = await multifrontDiagnostics(document);
    expect(ours.map(({code}) => code)).toContain('duplicate-target');
    expect(ours).toEqual(expectedDiagnostics(document, name));
  });

  it('reports nothing of ours on a valid file', async () => {
    const document = await server.openTextDocument(componentPath('Card.ucf'), 'ucf');
    expect(await multifrontDiagnostics(document)).toEqual([]);
  });
});
