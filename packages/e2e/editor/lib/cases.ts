import {checkBlocks, splitBlocks} from '@multifront/core';
import {TSSERVER_CODES} from '@multifront/language-tools';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {EXPECTED_IMPORTS} from '../../fixtures/apps/imports/expected.ts';
import {componentPath, FIXTURES_DIR, listComponents, readComponent} from '../../fixtures/index.ts';
import type {Document, LanguageServer} from './lsp.ts';
import {inBlock, locate} from './tsserver.ts';
import type {Component, TsDefinitions, TsDiagnostic, TsLocation, TsQuickInfo, Tsserver} from './tsserver.ts';

type Range = Parameters<LanguageServer['sendInlayHintRequest']>[1];

const SEVERITY = {error: 1, warning: 2} as const;

export const APP_DIR = join(FIXTURES_DIR, 'apps', 'imports');
export const CARD = readComponent('Card.front');

export function readApp(file: string): Component {
  const filename = join(APP_DIR, file);
  return {filename, source: readFileSync(filename, 'utf8')};
}

export const PLUGIN = '@multifront/language-tools/typescript-plugin';
export const APP = readApp('src/App.tsx');
export const MIXED = readApp('src/mixed.ts');
// The vue import, then the react one.
export const MIXED_LINES = EXPECTED_IMPORTS.filter(({file}) => file === 'src/mixed.ts').map(({line}) => line) as [number, number];

export const onLine = (diagnostics: TsDiagnostic[], line: number) => diagnostics.filter(({start}) => start.line === line);
export const codesOnLine = (diagnostics: TsDiagnostic[], line: number) => onLine(diagnostics, line).map(({code}) => code);

/** An unsaved edit; resolves to its undo. */
export async function edit(server: Tsserver, {filename, source}: Component, needle: string, newText: string) {
  const start = locate(source, needle);
  const end = locate(source, needle, needle.length);
  const change = (text: string, to: TsLocation) =>
    server.request('updateOpen', {changedFiles: [{fileName: filename, textChanges: [{start, end: to, newText: text}]}]});
  await change(newText, end);
  return () => change(needle, locate(source.replace(needle, newText), newText, newText.length));
}

export async function expectCardPropError(server: Tsserver, component: Component, needle: string, newText: string) {
  const revert = await edit(server, component, needle, newText);
  try {
    expect(codesOnLine(await server.diagnostics(APP.filename), locate(APP.source, '<Card').line)).toEqual([2322]);
  } finally {
    await revert();
  }
  expect(await server.diagnostics(APP.filename)).toEqual([]);
}

/** An unsaved `const picked = <binding>;`: Svelte's `Component`, not a Vue `DefineComponent` or a React function. */
export async function expectSvelteComponent(server: Tsserver, component: Component, binding: string): Promise<void> {
  // A `.svelte` file's binding is in scope only inside its script.
  const last = component.filename.endsWith('.svelte') ? '</script>' : component.source.trimEnd().split('\n').at(-1)!;
  const added = component.filename.endsWith('.svelte')
    ? `const picked = ${binding};\n${last}`
    : `${last}\nconst picked = ${binding};`;
  const revert = await edit(server, component, last, added);
  try {
    const info = await server.request<TsQuickInfo>('quickinfo', {
      file: component.filename,
      ...locate(component.source.replace(last, added), 'const picked', 6),
    });
    expect(info.displayString).toMatch(/^const picked: Component</);
  } finally {
    await revert();
  }
}

/** The 2.9 App.tsx cases; the caller's tsserver has `APP` and `CARD` open. */
export function appTsxCases(getServer: () => Tsserver): void {
  describe('App.tsx', () => {
    it('quickinfo on <Card shows its props', async () => {
      const info = await getServer().request<TsQuickInfo>('quickinfo', {file: APP.filename, ...locate(APP.source, '<Card', 1)});
      expect(info.displayString.replace(/\s+/g, ' ')).toContain('{ title: string; }');
    });

    it("definition on <Card lands in Card.front's <react> block", async () => {
      const at = locate(APP.source, '<Card', 1);
      const definitions = await getServer().request<TsDefinitions>('definition', {file: APP.filename, ...at});
      expect(definitions).toHaveLength(1);
      expect(inBlock(CARD, 'react', definitions[0]!)).toBe(true);
    });

    it('a wrong prop type is an error', async () => {
      await expectCardPropError(getServer(), APP, '"Hello"', '{1}');
    });
  });
}

function rangeOf(document: Document, start: number, end: number): Range {
  return {start: document.positionAt(start), end: document.positionAt(end)};
}

export function byStart(first: {range: Range; code?: unknown}, second: {range: Range; code?: unknown}): number {
  const {start: firstStart} = first.range;
  const {start: secondStart} = second.range;
  const byLine = firstStart.line - secondStart.line;
  return byLine || firstStart.character - secondStart.character || String(first.code).localeCompare(String(second.code));
}

type DiagnosticReport = Awaited<ReturnType<LanguageServer['sendDocumentDiagnosticRequest']>>;

/** Every source's diagnostics on the document, as the client pulls them. */
export async function diagnosticsOf(
  server: LanguageServer,
  document: Document
): Promise<Extract<DiagnosticReport, {items: unknown}>['items']> {
  const report = await server.sendDocumentDiagnosticRequest(document.uri);
  return 'items' in report ? report.items : [];
}

interface ServerDiagnostic {
  code: number | string | undefined;
  severity: number | undefined;
  message: string;
  range: Range;
}

export async function multifrontDiagnostics(server: LanguageServer, document: Document): Promise<ServerDiagnostic[]> {
  const ours = (await diagnosticsOf(server, document))
    .filter(({source}) => source === 'multifront')
    .map(({code, severity, message, range}) => ({code, severity, message, range}));
  return ours.sort(byStart);
}

function expectedDiagnostics(document: Document, name: string) {
  const {filename, source} = readComponent(name);
  const ours = checkBlocks(splitBlocks(source, filename)).filter(({code}) => !TSSERVER_CODES.has(code));
  const expected = ours.map(({code, severity, message, start, end}) => ({
    code,
    severity: SEVERITY[severity],
    message,
    range: rangeOf(document, start, end),
  }));
  return expected.sort(byStart);
}

async function styleErrors(server: LanguageServer, document: Document, {filename, source}: Component) {
  const {contentStart, contentEnd} = splitBlocks(source, filename).styles[0]!;
  return (await diagnosticsOf(server, document))
    .filter(({source: from}) => from !== 'multifront')
    .map(({source: from, range}) => {
      const start = document.offsetAt(range.start);
      return {from, inStyle: start >= contentStart && start < contentEnd};
    });
}

/** The 2.6 language server cases; the caller's server has `fixtures/components` as its workspace. */
export function languageServerCases(getServer: () => LanguageServer): void {
  describe('the language server serves <style> of Panel.front', () => {
    const {filename, source} = readComponent('Panel.front');
    const padding = source.indexOf('padding: $pad');

    it('completes a property name', async () => {
      const document = await getServer().openTextDocument(filename, 'front');
      const list = await getServer().sendCompletionRequest(document.uri, document.positionAt(padding + 2));
      expect(list?.items.map(({label}) => label)).toContain('padding');
    });

    it('hovers a property with its CSS docs, on its range in the .front file', async () => {
      const document = await getServer().openTextDocument(filename, 'front');
      const hover = await getServer().sendHoverRequest(document.uri, document.positionAt(padding + 2));
      expect(hover?.contents).toMatchObject({kind: 'markdown', value: expect.stringContaining('the padding area')});
      // The CSS service's range is the whole declaration.
      expect(hover?.range).toEqual(rangeOf(document, padding, padding + 'padding: $pad'.length));
    });

    it('goes from a scss variable to its declaration', async () => {
      const document = await getServer().openTextDocument(filename, 'front');
      const use = padding + 'padding: '.length;
      const result = await getServer().sendDefinitionRequest(document.uri, document.positionAt(use + 1));
      // The CSS service's target is the whole declaration.
      const declaration = '$pad: 1rem';
      const at = source.indexOf(declaration);
      expect(result).toEqual([{uri: document.uri, range: rangeOf(document, at, at + declaration.length)}]);
    });
  });

  describe('the language server reports checkBlocks on the .front file, minus the codes tsserver reports', () => {
    it.each(listComponents('invalid'))('%s', async (name) => {
      const document = await getServer().openTextDocument(componentPath(name), 'front');
      expect(await multifrontDiagnostics(getServer(), document)).toEqual(expectedDiagnostics(document, name));
    });

    it('reports on an unsaved buffer too (an untitled: URI, not a file)', async () => {
      const name = 'invalid/DuplicateReact.front';
      const document = await getServer().openUntitledDocument('front', readComponent(name).source);
      const ours = await multifrontDiagnostics(getServer(), document);
      expect(ours.map(({code}) => code)).toContain('duplicate-target');
      expect(ours).toEqual(expectedDiagnostics(document, name));
    });

    it('reports nothing of ours on a valid file', async () => {
      const document = await getServer().openTextDocument(componentPath('Card.front'), 'front');
      expect(await multifrontDiagnostics(getServer(), document)).toEqual([]);
    });
  });

  // M2 goal: "Inside <style>: CSS and SCSS ... errors".
  describe('the language server reports CSS and SCSS errors inside <style>', () => {
    it('invalid/ScssSyntaxError.front: an scss error inside its <style>', async () => {
      const component = readComponent('invalid/ScssSyntaxError.front');
      const document = await getServer().openTextDocument(component.filename, 'front');
      const errors = await styleErrors(getServer(), document, component);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors).toEqual(errors.map(() => ({from: 'scss', inStyle: true})));
    });

    it('editor/CssDeclarationError.front as an unsaved buffer: a css error inside its <style>', async () => {
      const component = readComponent('editor/CssDeclarationError.front');
      const document = await getServer().openUntitledDocument('front', component.source);
      const errors = await styleErrors(getServer(), document, component);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors).toEqual(errors.map(() => ({from: 'css', inStyle: true})));
    });
  });
}
