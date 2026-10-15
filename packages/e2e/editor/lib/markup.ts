import {loadSvelteCompiler, splitBlocks} from '@multifront/core';
import {expect} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import type {LanguageServer} from './lsp.ts';
import type {Component} from './tsserver.ts';

const compiler = loadSvelteCompiler(FIXTURES_DIR)!;

type Document = Awaited<ReturnType<LanguageServer['updateTextDocument']>>;
type CompletionList = NonNullable<Awaited<ReturnType<LanguageServer['sendCompletionRequest']>>>;
type CompletionItem = CompletionList['items'][number];

export interface Completed {
  items: CompletionItem[];
  document: Document;
  cursor: number;
  component: Component;
}

/** The language server's completions in `component`, each one on an unsaved edit undone after. */
export function markupCompletions(getServer: () => LanguageServer, component: Component) {
  async function completeIn(source: string, cursor: number): Promise<Completed> {
    const server = getServer();
    const document = await server.openTextDocument(component.filename, 'ucf');
    const whole = (on: typeof document) => ({start: {line: 0, character: 0}, end: on.positionAt(on.getText().length)});
    const edited = await server.updateTextDocument(document.uri, [{range: whole(document), newText: source}]);
    try {
      const list = await server.sendCompletionRequest(document.uri, edited.positionAt(cursor));
      return {items: list?.items ?? [], document: edited, cursor, component};
    } finally {
      await server.updateTextDocument(document.uri, [{range: whole(edited), newText: component.source}]);
    }
  }

  /** Types `typed` (its `|` is the cursor) right after `after` in `source`. */
  function complete(after: string, typed: string, source = component.source): Promise<Completed> {
    const index = source.indexOf(after);
    if (index < 0) throw new Error(`${after} not in the source`);
    const at = index + after.length;
    return completeIn(source.slice(0, at) + typed.replace('|', '') + source.slice(at), at + typed.indexOf('|'));
  }

  return {completeIn, complete};
}

export const labels = ({items}: Completed): string[] => items.map(({label}) => label);

export function newText({items}: Completed, label: string): string | undefined {
  const edit = items.find((item) => item.label === label)?.textEdit;
  return edit && 'range' in edit ? edit.newText : undefined;
}

/** A snippet as the user finishes it: each tab stop holds its placeholder, or `x`; `$0` stays empty. */
export function fillSnippet(snippet: string): string {
  return snippet
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$0/g, '')
    .replace(/\$\d+/g, 'x');
}

/** `item` applied at `cursor`; `end` is just after the inserted text. */
export function applyCompletion(document: Document, item: CompletionItem, cursor: number): {text: string; end: number} {
  const source = document.getText();
  const edit = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
  const [start, end] = edit ? [document.offsetAt(edit.range.start), document.offsetAt(edit.range.end)] : [cursor, cursor];
  const raw = edit?.newText ?? item.insertText ?? item.label;
  const inserted = item.insertTextFormat === 2 ? fillSnippet(raw) : raw;
  return {text: source.slice(0, start) + inserted + source.slice(end), end: start + inserted.length};
}

/** The real `svelte/compiler` `parse` (modern, not loose) of the file's `<svelte>` block: its error, if any. */
export function svelteParseError(source: string, filename: string): string | undefined {
  const block = splitBlocks(source, filename).targets.svelte!;
  try {
    compiler.parse(block.content, {modern: true});
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Each item applied as the user finishes it (` />` after a tag name) leaves a block Svelte's parser accepts. */
export function expectEveryItemParses({items, document, cursor, component}: Completed, tag = false): void {
  expect(items.length).toBeGreaterThan(0);
  const failures = items.flatMap((item) => {
    const {text, end} = applyCompletion(document, item, cursor);
    const finished = tag ? `${text.slice(0, end)} />${text.slice(end)}` : text;
    const error = svelteParseError(finished, component.filename);
    return error ? [`${item.label}: ${error}`] : [];
  });
  expect(failures).toEqual([]);
}
