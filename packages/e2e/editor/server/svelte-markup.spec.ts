// Completions in the <svelte> markup: HTML tags and attributes, Svelte elements, directives and blocks from our
// language server; `{…}` expressions from tsserver with our plugin (hybrid mode). Every suggestion must parse.
import {loadSvelteCompiler, splitBlocks} from '@multifront/core';
import {join} from 'node:path';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, readComponent} from '../../fixtures/index.ts';
import {edit, PLUGIN} from '../lib/cases.ts';
import {startLanguageServer} from '../lib/lsp.ts';
import type {LanguageServer} from '../lib/lsp.ts';
import {locate, open, startTsserver} from '../lib/tsserver.ts';
import type {Tsserver} from '../lib/tsserver.ts';

const APP_DIR = join(FIXTURES_DIR, 'apps', 'svelte-markup');
const TOOLBAR = readComponent(join('..', 'apps', 'svelte-markup', 'Toolbar.ucf'));
const compiler = loadSvelteCompiler(FIXTURES_DIR)!;
const META = ['svelte:window', 'svelte:document', 'svelte:body', 'svelte:head', 'svelte:options'];

let server: LanguageServer;
let tsserver: Tsserver;

beforeAll(async () => {
  server = await startLanguageServer(APP_DIR);
  tsserver = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
  // No tsconfig: these options stand in for an app's.
  await tsserver.request('compilerOptionsForInferredProjects', {
    options: {strict: true, module: 'preserve', moduleResolution: 'bundler', target: 'es2022', jsx: 'react-jsx'},
  });
  await open(tsserver, [TOOLBAR]);
});

afterAll(async () => {
  await server?.stop();
  await tsserver?.stop();
});

type Completed = Awaited<ReturnType<typeof completeIn>>;
type CompletionItem = Completed['items'][number];
type Document = Completed['document'];

/** Sets the document to `source`, unsaved, and asks the server for completions at `cursor`. */
async function completeIn(source: string, cursor: number) {
  const document = await server.openTextDocument(TOOLBAR.filename, 'ucf');
  const whole = (on: typeof document) => ({start: {line: 0, character: 0}, end: on.positionAt(on.getText().length)});
  const edited = await server.updateTextDocument(document.uri, [{range: whole(document), newText: source}]);
  try {
    const list = await server.sendCompletionRequest(document.uri, edited.positionAt(cursor));
    return {items: list?.items ?? [], document: edited, cursor};
  } finally {
    await server.updateTextDocument(document.uri, [{range: whole(edited), newText: TOOLBAR.source}]);
  }
}

/** Types `typed` (its `|` is the cursor) right after `after` in `source`. */
function complete(after: string, typed: string, source = TOOLBAR.source) {
  const index = source.indexOf(after);
  if (index < 0) throw new Error(`${after} not in the source`);
  const at = index + after.length;
  return completeIn(source.slice(0, at) + typed.replace('|', '') + source.slice(at), at + typed.indexOf('|'));
}

const labels = ({items}: Completed) => items.map(({label}) => label);
const newText = ({items}: Completed, label: string) => {
  const edit = items.find((item) => item.label === label)?.textEdit;
  return edit && 'range' in edit ? edit.newText : undefined;
};

/** A snippet as the user finishes it: each tab stop holds its placeholder, or `x`; `$0` stays empty. */
function fillSnippet(snippet: string): string {
  return snippet
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$0/g, '')
    .replace(/\$\d+/g, 'x');
}

/** `document`'s text with `item` applied at `cursor`, and the offset just after the inserted text. */
function applyCompletion(document: Document, item: CompletionItem, cursor: number): {text: string; end: number} {
  const source = document.getText();
  const edit = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
  const [start, end] = edit ? [document.offsetAt(edit.range.start), document.offsetAt(edit.range.end)] : [cursor, cursor];
  const raw = edit?.newText ?? item.insertText ?? item.label;
  const inserted = item.insertTextFormat === 2 ? fillSnippet(raw) : raw;
  return {text: source.slice(0, start) + inserted + source.slice(end), end: start + inserted.length};
}

/** Each item applied as the user finishes it (` />` after a tag name) leaves a block Svelte's parser accepts. */
function expectEveryItemParses({items, document, cursor}: Completed, tag = false): void {
  expect(items.length).toBeGreaterThan(0);
  const failures = items.flatMap((item) => {
    const {text, end} = applyCompletion(document, item, cursor);
    const finished = tag ? `${text.slice(0, end)} />${text.slice(end)}` : text;
    const block = splitBlocks(finished, TOOLBAR.filename).targets.svelte!;
    try {
      compiler.parse(block.content, {modern: true});
      return [];
    } catch (err) {
      return [`${item.label}: ${(err as Error).message}`];
    }
  });
  expect(failures).toEqual([]);
}

describe('the language server: tags and Svelte elements', () => {
  it('<sv at the top level lists svelte:window, every Svelte element and div; each one parses', async () => {
    const completed = await complete('  </script>\n', '  <sv|\n');
    expect(labels(completed)).toEqual(expect.arrayContaining([...META, 'svelte:element', 'svelte:boundary', 'div']));
    expect(newText(completed, 'svelte:element')).toBe('svelte:element this={$1}');
    expectEveryItemParses(completed, true);
  });

  it('<sv inside an element lists svelte:boundary and svelte:element, no top-level-only element; each one parses', async () => {
    const completed = await complete('<h2>{title}</h2>\n', '    <sv|\n');
    expect(labels(completed)).toEqual(expect.arrayContaining(['svelte:boundary', 'svelte:element', 'span']));
    for (const meta of META) expect(labels(completed)).not.toContain(meta);
    expectEveryItemParses(completed, true);
  });

  it('<sv after a <svelte:window> lists no second one; each item parses', async () => {
    const completed = await complete('  </script>\n', '  <svelte:window />\n  <sv|\n');
    expect(labels(completed)).not.toContain('svelte:window');
    expect(labels(completed)).toContain('svelte:head');
    expectEveryItemParses(completed, true);
  });

  it('<sc at the top level lists script beside a <script module> only, never beside the instance script', async () => {
    expect(labels(await complete('  </script>\n', '  <sc|\n'))).not.toContain('script');
    const moduleOnly = TOOLBAR.source.replace('<script lang="ts">', '<script module lang="ts">');
    expect(labels(await complete('  </script>\n', '  <sc|\n', moduleOnly))).toContain('script');
  });
});

describe('the language server: attributes and directives', () => {
  it('<input bi lists bind:value, bind:this and the bind: prefix; each one parses', async () => {
    const completed = await complete('<h2>{title}</h2>\n', '    <input bi| />\n');
    expect(labels(completed)).toEqual(expect.arrayContaining(['bind:value', 'bind:this', 'bind:', 'class:', 'type']));
    expectEveryItemParses(completed);
  });

  // Svelte's parser takes `onclick="x"`: only its analysis rejects a string handler, so the parse check cannot.
  it('directives and event attributes take an expression; a prefix a name', async () => {
    const completed = await complete('<h2>{title}</h2>\n', '    <input bi| />\n');
    expect(['bind:value', 'onclick', 'bind:', 'type'].map((label) => newText(completed, label))).toEqual([
      'bind:value={$1}',
      'onclick={$1}',
      'bind:${1:name}',
      'type="$1"',
    ]);
  });
});

describe('the language server: {#…}, {@…} and {:…} blocks', () => {
  // VS Code auto-closes `{` in .ucf files: typing `{#` there holds `{#}`.
  it.each(['{#|', '{#|}'])('%s lists if, each, await, key and snippet; each one parses', async (typed) => {
    const completed = await complete('<h2>{title}</h2>\n', `    ${typed}\n`);
    expect(labels(completed)).toEqual(['if', 'each', 'await', 'key', 'snippet']);
    expectEveryItemParses(completed);
  });

  it.each([
    {where: 'in a <script>', after: "let query = $state('')\n", typed: '    {#|}\n'},
    {where: 'in a comment', after: '<h2>{title}</h2>\n', typed: '    <!-- {#|} -->\n'},
  ])('{# $where lists nothing', async ({after, typed}) => {
    expect(labels(await complete(after, typed))).toEqual([]);
  });

  it('{@ at the top level lists render, html and debug, not const; each one parses', async () => {
    const completed = await complete('  </div>\n', '  {@|}\n');
    expect(labels(completed)).toEqual(['render', 'html', 'debug']);
    expectEveryItemParses(completed);
  });

  // Svelte checks `{@const}` placement in its analysis, not its parser: these pin the rule itself.
  it.each([
    {where: 'directly inside {#each}', after: '<li>{item}</li>\n', typed: '          {@|}\n', allowed: true},
    {where: 'in an {:else if} branch', after: '</ul>\n', typed: '    {:else if title}\n      {@|}\n', allowed: true},
    {
      where: 'in a <svelte:boundary>',
      after: '<h2>{title}</h2>\n',
      typed: '    <svelte:boundary>{@|}</svelte:boundary>\n',
      allowed: true,
    },
    {where: 'in a plain element', after: '<h2>{title}</h2>\n', typed: '    <p>{@|}</p>\n', allowed: false},
  ])('{@ $where lists const: $allowed; each item parses', async ({after, typed, allowed}) => {
    const completed = await complete(after, typed);
    expect(labels(completed)).toEqual(allowed ? ['render', 'html', 'const', 'debug'] : ['render', 'html', 'debug']);
    expectEveryItemParses(completed);
  });

  it('{: inside {#if} lists else only; it parses', async () => {
    const completed = await complete('</ul>\n', '    {:|}\n');
    expect(labels(completed)).toEqual(['else']);
    expectEveryItemParses(completed);
  });

  it('{:else typed in full inside {#if} still lists else', async () => {
    expect(labels(await complete('</ul>\n', '    {:else|}\n'))).toEqual(['else']);
  });

  it('{: in an {#if} that has its {:else} lists nothing', async () => {
    expect(labels(await complete('</ul>\n', '    {:else}\n      <p>none</p>\n      {:|}\n'))).toEqual([]);
  });

  it('{: in the pending branch of an {#await} that has its {:then} lists catch only; it parses', async () => {
    const completed = await complete('<p>Loading</p>\n', '      {:|}\n');
    expect(labels(completed)).toEqual(['catch']);
    expectEveryItemParses(completed);
  });

  it('{: inside an {#await} with no clause lists then and catch; each one parses', async () => {
    const completed = await complete('<li>{item}</li>\n', '          {#await load}\n            {:|}\n          {/await}\n');
    expect(labels(completed)).toEqual(['then', 'catch']);
    expectEveryItemParses(completed);
  });

  it('{: inside {#await … then …} lists catch only; it parses', async () => {
    const completed = await complete(
      '<li>{item}</li>\n',
      '          {#await load then text}\n            {:|}\n          {/await}\n'
    );
    expect(labels(completed)).toEqual(['catch']);
    expectEveryItemParses(completed);
  });

  it('{: at the top level lists nothing', async () => {
    expect(labels(await complete('  </div>\n', '  {:|}\n'))).toEqual([]);
  });
});

describe('inside {…}: TypeScript only', () => {
  // As VS Code holds `{ti`: `{` auto-closed.
  const [needle, replacement] = ['<h2>{title}</h2>', '<h2>{title}</h2>\n    <p>{ti}</p>'];

  it('tsserver with our plugin lists the title prop', async () => {
    const revert = await edit(tsserver, TOOLBAR, needle, replacement);
    try {
      const at = locate(TOOLBAR.source.replace(needle, replacement), '{ti}', '{ti'.length);
      const {entries} = await tsserver.request<ts.server.protocol.CompletionInfo>('completionInfo', {
        file: TOOLBAR.filename,
        ...at,
      });
      expect(entries.map(({name}) => name)).toContain('title');
    } finally {
      await revert();
    }
  });

  it('the language server lists nothing there', async () => {
    expect(labels(await complete('<h2>{title}</h2>\n', '    <p>{ti|}</p>\n'))).toEqual([]);
  });
});

// Last: a plugin that throws logs a warning.
it('the language server logged no warning or error', () => {
  expect(server.log.filter(({type}) => type <= 2)).toEqual([]);
});
