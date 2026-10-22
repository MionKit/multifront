// The <vue> row in the editor: tsserver serves its script beside the react one; the server reads its blocks.
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {diagnosticsOf, edit, multifrontDiagnostics, PLUGIN} from './lib/cases.ts';
import {startLanguageServer, TSDK} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {locate, open, startTsserver, tsLocation} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsLocation, TsQuickInfo, Tsserver} from './lib/tsserver.ts';
import type * as ts from 'typescript';

const COUNTER = readComponent('Counter.front');
const COUNTER_CRLF = readComponent('vue/CounterCrlf.front');
const UNCLOSED = readComponent('vue/VueWithUnclosedReact.front');
const EMPTY = readComponent('vue/Empty.front');
// A plain `<script setup>`: its script is JavaScript.
const GRAMMAR_EDGES = readComponent('editor/GrammarEdges.front');
const IMPORT_ERRORS = readComponent('editor/ImportErrors.front');
const VUE_ONLY = readComponent('imports/VueOnly.front');

async function diagnosticsAfter(server: Tsserver, component: Component, needle: string, newText: string) {
  const revert = await edit(server, component, needle, newText);
  try {
    return (await server.diagnostics(component.filename)).map(({code, start, end}) => ({code, start, end}));
  } finally {
    await revert();
  }
}

// Where `text` sits once `needle` became `newText`.
function spanAfter({source}: Component, needle: string, newText: string, text: string) {
  const edited = source.replace(needle, newText);
  const start = edited.indexOf(text, source.indexOf(needle));
  return {start: tsLocation(edited, start), end: tsLocation(edited, start + text.length)};
}

describe('tsserver serves the vue script beside the react one', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath(''), plugins: [PLUGIN]});
    // The fixtures sit in no tsconfig project: these options stand in for an app's.
    await server.request('compilerOptionsForInferredProjects', {
      options: {strict: true, module: 'preserve', moduleResolution: 'bundler', target: 'es2022', jsx: 'react-jsx'},
    });
    await open(server, [COUNTER, COUNTER_CRLF, UNCLOSED, GRAMMAR_EDGES]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it.each([COUNTER, COUNTER_CRLF])('$filename has no diagnostic as written', async ({filename}) => {
    expect(await server.diagnostics(filename)).toEqual([]);
  });

  it.each([COUNTER, COUNTER_CRLF])(
    'a wrong type in a template expression is one TS2345, at its .front range',
    async (component) => {
      const [needle, newText] = ['{{ count }}', "{{ count.toFixed('x') }}"];
      expect(await diagnosticsAfter(server, component, needle, newText)).toEqual([
        {code: 2345, ...spanAfter(component, needle, newText, "'x'")},
      ]);
    }
  );

  it('a $style typo is one TS2551 (strictCssModules), at the name', async () => {
    const [needle, newText] = ['$style.button', '$style.buton'];
    expect(await diagnosticsAfter(server, COUNTER, needle, newText)).toEqual([
      {code: 2551, ...spanAfter(COUNTER, needle, newText, 'buton')},
    ]);
  });

  it('quickinfo in <react> shows the react types, in <vue> the vue ones', async () => {
    const quickinfo = (needle: string) =>
      server.request<TsQuickInfo>('quickinfo', {file: COUNTER.filename, ...locate(COUNTER.source, needle)});
    expect((await quickinfo('setCount(count + 1)')).displayString).toContain('SetStateAction<number>');
    expect((await quickinfo('count = ref')).displayString).toContain('Ref<number, number>');
  });

  it('definition from a template expression lands on its <script setup> declaration', async () => {
    const at = locate(COUNTER.source, '{{ count }}', 3);
    const definitions = await server.request<TsDefinitions>('definition', {file: COUNTER.filename, ...at});
    const declaration = COUNTER.source.indexOf('count = ref');
    expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
      {file: COUNTER.filename, start: tsLocation(COUNTER.source, declaration)},
    ]);
  });

  describe('references, highlights and rename on a <script setup> binding stay in the .front file', () => {
    const at = () => ({file: COUNTER.filename, ...locate(COUNTER.source, 'count = ref')});
    // The declaration, `{{ count }}` and `count++`: Vue's generated uses map back onto them or are dropped.
    const vueUses = ['count = ref', 'count++', 'count }}'].map((needle) => locate(COUNTER.source, needle));
    const sorted = (locations: TsLocation[]) =>
      [...locations].sort((first, second) => first.line - second.line || first.offset - second.offset);

    it('references', async () => {
      const {refs} = await server.request<ts.server.protocol.ReferencesResponseBody>('references', at());
      expect(refs.map(({file}) => file)).toEqual(refs.map(() => COUNTER.filename));
      expect(sorted(refs.map(({start}) => start))).toEqual(sorted(vueUses));
    });

    it('documentHighlights', async () => {
      const highlights = await server.request<ts.server.protocol.DocumentHighlightsItem[]>('documentHighlights', {
        ...at(),
        filesToSearch: [COUNTER.filename],
      });
      // One group per linked position, as Volar gives for a `.vue` file: all in Counter.front.
      expect(new Set(highlights.map(({file}) => file))).toEqual(new Set([COUNTER.filename]));
      const starts = highlights.flatMap(({highlightSpans}) => highlightSpans.map(({start}) => JSON.stringify(start)));
      expect(sorted([...new Set(starts)].map((start) => JSON.parse(start) as TsLocation))).toEqual(sorted(vueUses));
    });

    it('rename', async () => {
      const {locs} = await server.request<ts.server.protocol.RenameResponseBody>('rename', at());
      expect(locs.map(({file}) => file)).toEqual([COUNTER.filename]);
      expect(sorted(locs[0]!.locs.map(({start}) => start))).toEqual(sorted(vueUses));
    });
  });

  it('a plain <script setup> is served as JavaScript: no diagnostic, its types inferred', async () => {
    expect(await server.diagnostics(GRAMMAR_EDGES.filename)).toEqual([]);
    const at = locate(GRAMMAR_EDGES.source, '{{ small }}', 3);
    const info = await server.request<TsQuickInfo>('quickinfo', {file: GRAMMAR_EDGES.filename, ...at});
    expect(info.displayString).toContain('boolean');
  });

  it('an unclosed <react> block reaches neither script: no diagnostic', async () => {
    expect(await server.diagnostics(UNCLOSED.filename)).toEqual([]);
  });
});

describe('a .front file a project reaches only through an import', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath('editor'), plugins: [PLUGIN]});
    await open(server, [IMPORT_ERRORS, VUE_ONLY]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('is served in that project: no root, but its <vue> script is checked', async () => {
    const projectInfo = () =>
      server.request<ts.server.protocol.ProjectInfo>('projectInfo', {file: VUE_ONLY.filename, needFileNameList: true});
    expect((await projectInfo()).configFileName).toBe(componentPath('editor/tsconfig.json'));
    // No edit yet: the program that first reached the file asked for the next one, which holds its script.
    expect((await projectInfo()).fileNames).toContain(`${VUE_ONLY.filename}.vue.ts`);
    const [needle, newText] = ['Only Vue', '{{ missing }}'];
    expect(await diagnosticsAfter(server, VUE_ONLY, needle, newText)).toEqual([
      {code: 2339, ...spanAfter(VUE_ONLY, needle, newText, 'missing')},
    ]);
  });
});

describe('the language server reads the <vue> block', () => {
  let server: LanguageServer;
  // No tsdk an editor could name: the server still answers, with no <vue> code.
  let badTsdk: LanguageServer;

  beforeAll(async () => {
    const workspace = join(FIXTURES_DIR, 'components');
    server = await startLanguageServer(workspace, {initializationOptions: {typescript: {tsdk: TSDK}}});
    badTsdk = await startLanguageServer(workspace, {initializationOptions: {typescript: {tsdk: join(FIXTURES_DIR, 'none')}}});
  });

  afterAll(async () => {
    await Promise.all([server?.stop(), badTsdk?.stop()]);
  });

  // Volar's own request for the code tree, as its "show virtual files" view uses.
  async function codeIds(languageServer: LanguageServer, uri: string): Promise<string[]> {
    type Code = {virtualCodeId: string; embeddedCodes: Code[]};
    const root = await languageServer.connection.sendRequest<Code | null>('volar/client/virtualFiles', {uri});
    const ids = (codes: Code[] = []): string[] =>
      codes.flatMap(({virtualCodeId, embeddedCodes}) => [virtualCodeId, ...ids(embeddedCodes)]);
    return ids(root?.embeddedCodes);
  }

  it('builds the vue code with TypeScript from the tsdk, and none without it', async () => {
    const document = await server.openTextDocument(COUNTER.filename, 'front');
    expect(await codeIds(server, document.uri)).toEqual(expect.arrayContaining(['vue', 'script_ts', 'template']));
    const withoutTs = await badTsdk.openTextDocument(COUNTER.filename, 'front');
    const ids = await codeIds(badTsdk, withoutTs.uri);
    expect(ids).not.toContain('vue');
    expect(ids).toEqual(expect.arrayContaining(['react', 'style_0', 'style_1']));
  });

  it('a tsdk with no TypeScript leaves the other blocks served', async () => {
    const document = await badTsdk.openTextDocument(EMPTY.filename, 'front');
    expect((await multifrontDiagnostics(badTsdk, document)).map(({code}) => code)).toEqual(['vue-empty-block']);
  });

  it('Empty.front: vue-empty-block on the <vue> line, and nothing else', async () => {
    const document = await server.openTextDocument(EMPTY.filename, 'front');
    const diagnostics = await multifrontDiagnostics(server, document);
    expect(diagnostics.map(({code, range}) => ({code, line: range.start.line}))).toEqual([{code: 'vue-empty-block', line: 0}]);
    expect(await diagnosticsOf(server, document)).toHaveLength(1);
  });

  it('VueWithUnclosedReact.front: the splitter’s unclosed-block, and nothing from the <react> text', async () => {
    const document = await server.openTextDocument(UNCLOSED.filename, 'front');
    const diagnostics = await diagnosticsOf(server, document);
    expect(diagnostics.map(({source, code}) => ({source, code}))).toEqual([{source: 'multifront', code: 'unclosed-block'}]);
  });

  describe('Counter.front: one answer per <style> block, Vue’s own style codes left out', () => {
    const needle = 'color: rgb(120, 40, 160);';
    const source = COUNTER.source.replace(needle, `${needle}\n  colr: red;`);

    it('a CSS error in <style scoped> is one CSS diagnostic', async () => {
      const document = await server.openUntitledDocument('front', source);
      const diagnostics = await diagnosticsOf(server, document);
      expect(diagnostics.map(({source: from, range}) => ({from, start: document.offsetAt(range.start)}))).toEqual([
        {from: 'css', start: source.indexOf('colr')},
      ]);
    });

    it('a hover on a property has its docs once', async () => {
      const document = await server.openUntitledDocument('front', source);
      const hover = await server.sendHoverRequest(document.uri, document.positionAt(source.indexOf(needle) + 1));
      expect(hover?.contents).toMatchObject({kind: 'markdown'});
      const {value} = hover!.contents as {value: string};
      const firstLine = value.split('\n')[0]!;
      expect(firstLine).not.toBe('');
      expect(value.split(firstLine)).toHaveLength(2);
    });
  });
});
