// A component's props in the <svelte> markup: `<Icon ` completes Icon's props from tsserver with our plugin (hybrid
// mode), and an unknown prop is an error there; our language server offers only what Svelte takes on a component.
import {join} from 'node:path';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, readComponent} from '../../fixtures/index.ts';
import {edit, PLUGIN} from '../lib/cases.ts';
import {expectEveryItemParses, labels, markupCompletions, svelteParseError} from '../lib/markup.ts';
import {startLanguageServer} from '../lib/lsp.ts';
import type {LanguageServer} from '../lib/lsp.ts';
import {offsetAt, open, startTsserver, tsLocation} from '../lib/tsserver.ts';
import type {TsLocation, Tsserver} from '../lib/tsserver.ts';

const APP_DIR = join(FIXTURES_DIR, 'apps', 'svelte-markup');
const TOOLBAR = readComponent(join('..', 'apps', 'svelte-markup', 'Toolbar.ucf'));
const ICON = readComponent(join('..', 'apps', 'svelte-markup', 'Icon.ucf'));
const ANCHOR = '    <Icon name="search" />\n';
// Icon's own two, and the `class` and `style` its single root element takes (spec 3.5.1).
const PROPS = ['name', 'class', 'size', 'style'];

let server: LanguageServer;
let tsserver: Tsserver;

beforeAll(async () => {
  server = await startLanguageServer(APP_DIR);
  tsserver = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
  // No tsconfig: these options stand in for an app's.
  await tsserver.request('compilerOptionsForInferredProjects', {
    options: {strict: true, module: 'preserve', moduleResolution: 'bundler', target: 'es2022', jsx: 'react-jsx'},
  });
  await open(tsserver, [TOOLBAR, ICON]);
});

afterAll(async () => {
  await server?.stop();
  await tsserver?.stop();
});

interface Typed {
  source: string;
  cursor: number;
  at: TsLocation;
}

/** `typed` (its `|` is the cursor) as an unsaved line after the fixture's `<Icon name="search" />`, undone after. */
async function withTyped<Result>(typed: string, check: (edited: Typed) => Promise<Result>): Promise<Result> {
  const text = typed.replace('|', '');
  const revert = await edit(tsserver, TOOLBAR, ANCHOR, ANCHOR + text);
  try {
    const source = TOOLBAR.source.replace(ANCHOR, ANCHOR + text);
    const cursor = TOOLBAR.source.indexOf(ANCHOR) + ANCHOR.length + typed.indexOf('|');
    return await check({source, cursor, at: tsLocation(source, cursor)});
  } finally {
    await revert();
  }
}

// tsserver answers "No content available" where no mapping takes the position.
async function completionInfo(at: TsLocation): Promise<ts.server.protocol.CompletionInfo | undefined> {
  try {
    return await tsserver.request<ts.server.protocol.CompletionInfo>('completionInfo', {file: TOOLBAR.filename, ...at});
  } catch (err) {
    if ((err as Error).message.includes('No content available')) return undefined;
    throw err;
  }
}

const entryNames = (info: ts.server.protocol.CompletionInfo | undefined): string[] => info?.entries.map(({name}) => name) ?? [];

const completedIn = (typed: string) => withTyped(typed, async ({at}) => entryNames(await completionInfo(at)));

describe('tsserver with our plugin: props in a component start tag', () => {
  it('Toolbar.ucf as written has no diagnostic', async () => {
    expect(await tsserver.diagnostics(TOOLBAR.filename)).toEqual([]);
  });

  it('<Icon typed unclosed lists its props, with their types', async () => {
    await withTyped('    <Icon |\n', async ({at}) => {
      expect(entryNames(await completionInfo(at))).toEqual(PROPS);
      const details = await tsserver.request<ts.server.protocol.CompletionEntryDetails[]>('completionEntryDetails', {
        file: TOOLBAR.filename,
        ...at,
        entryNames: PROPS,
      });
      expect(details.map(({displayParts}) => displayParts.map(({text}) => text).join(''))).toEqual([
        '(property) name: string',
        '(property) class?: ClassValue | null | undefined',
        '(property) size?: number | undefined',
        '(property) style?: string | null | undefined',
      ]);
    });
  });

  it.each([
    {typed: '    <Icon | />\n', props: PROPS},
    {typed: '    <Icon name="x" | />\n', props: ['class', 'size', 'style']},
    {typed: '    <Icon\n      |\n    />\n', props: PROPS},
  ])('$typed lists $props', async ({typed, props}) => {
    expect(await completedIn(typed)).toEqual(props);
  });

  it('each prop of <Icon | />, applied as VS Code applies it, parses', async () => {
    await withTyped('    <Icon | />\n', async ({source, cursor, at}) => {
      const info = await completionInfo(at);
      expect(entryNames(info)).toEqual(PROPS);
      const failures = info!.entries.flatMap(({name, insertText, replacementSpan}) => {
        const span = replacementSpan ?? info!.optionalReplacementSpan;
        const [start, end] = span ? [offsetAt(source, span.start), offsetAt(source, span.end)] : [cursor, cursor];
        const error = svelteParseError(source.slice(0, start) + (insertText ?? name) + source.slice(end), TOOLBAR.filename);
        return error ? [`${name}: ${error}`] : [];
      });
      expect(failures).toEqual([]);
    });
  });

  it('<Icon| (on the tag name) lists names in scope, not the props', async () => {
    const names = await completedIn('    <Icon| />\n');
    expect(names).toContain('Icon');
    expect(names).not.toContain('size');
  });

  it('<input | /> (an element) lists nothing', async () => {
    expect(await completedIn('    <input | />\n')).toEqual([]);
  });

  it('<Icon nme="x"/> is one TS2353, on nme', async () => {
    await withTyped('    <Icon nme="x"/>|\n', async ({source, cursor}) => {
      const diagnostics = await tsserver.diagnostics(TOOLBAR.filename);
      const nme = cursor - 'nme="x"/>'.length;
      expect(
        diagnostics.map(({code, start, end}) => ({code, start: offsetAt(source, start), end: offsetAt(source, end)}))
      ).toEqual([{code: 2353, start: nme, end: nme + 'nme'.length}]);
    });
    expect(await tsserver.diagnostics(TOOLBAR.filename)).toEqual([]);
  });
});

describe('the language server in a component start tag', () => {
  const {complete} = markupCompletions(() => server, TOOLBAR);

  it('<Icon | /> lists only bind: and bind:this; each one parses', async () => {
    const completed = await complete(ANCHOR, '    <Icon | />\n');
    expect(labels(completed).toSorted()).toEqual(['bind:', 'bind:this']);
    expectEveryItemParses(completed);
  });

  it('<input bi| /> still lists the element attributes and directives', async () => {
    const completed = await complete(ANCHOR, '    <input bi| />\n');
    expect(labels(completed)).toEqual(expect.arrayContaining(['bind:value', 'bind:this', 'bind:', 'class:', 'type']));
  });
});

// Last: a plugin that throws logs a warning.
it('the language server logged no warning or error', () => {
  expect(server.log.filter(({type}) => type <= 2)).toEqual([]);
});
