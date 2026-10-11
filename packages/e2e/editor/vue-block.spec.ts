// The <vue> row in the editor: tsserver serves its script beside the react one; the server reads its blocks.
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {edit, multifrontDiagnostics, PLUGIN} from './lib/cases.ts';
import {startLanguageServer, TSDK} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {locate, open, startTsserver, tsLocation} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';

const COUNTER = readComponent('Counter.ucf');
const COUNTER_CRLF = readComponent('vue/CounterCrlf.ucf');
const UNCLOSED = readComponent('vue/VueWithUnclosedReact.ucf');
const EMPTY = readComponent('vue/Empty.ucf');

describe('tsserver serves the vue script beside the react one', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath(''), plugins: [PLUGIN]});
    // The fixtures sit in no tsconfig project: these options stand in for an app's.
    await server.request('compilerOptionsForInferredProjects', {
      options: {strict: true, module: 'preserve', moduleResolution: 'bundler', target: 'es2022', jsx: 'react-jsx'},
    });
    await open(server, [COUNTER, COUNTER_CRLF, UNCLOSED]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  async function diagnosticsAfter(component: Component, needle: string, newText: string) {
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

  it.each([COUNTER, COUNTER_CRLF])('$filename has no diagnostic as written', async ({filename}) => {
    expect(await server.diagnostics(filename)).toEqual([]);
  });

  it.each([COUNTER, COUNTER_CRLF])(
    'a wrong type in a template expression is one TS2345, at its .ucf range',
    async (component) => {
      const [needle, newText] = ['{{ count }}', "{{ count.toFixed('x') }}"];
      expect(await diagnosticsAfter(component, needle, newText)).toEqual([
        {code: 2345, ...spanAfter(component, needle, newText, "'x'")},
      ]);
    }
  );

  it('a $style typo is one TS2551 (strictCssModules), at the name', async () => {
    const [needle, newText] = ['$style.button', '$style.buton'];
    expect(await diagnosticsAfter(COUNTER, needle, newText)).toEqual([
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

  it('an unclosed <react> block reaches neither script: no diagnostic', async () => {
    expect(await server.diagnostics(UNCLOSED.filename)).toEqual([]);
  });
});

describe('the language server reads the <vue> block', () => {
  let server: LanguageServer;

  beforeAll(async () => {
    server = await startLanguageServer(join(FIXTURES_DIR, 'components'), {initializationOptions: {typescript: {tsdk: TSDK}}});
  });

  afterAll(async () => {
    await server?.stop();
  });

  async function allDiagnostics(uri: string) {
    const report = await server.sendDocumentDiagnosticRequest(uri);
    return 'items' in report ? report.items : [];
  }

  it('Empty.ucf: vue-empty-block on the <vue> line, and nothing else', async () => {
    const document = await server.openTextDocument(EMPTY.filename, 'ucf');
    const diagnostics = await multifrontDiagnostics(server, document);
    expect(diagnostics.map(({code, range}) => ({code, line: range.start.line}))).toEqual([{code: 'vue-empty-block', line: 0}]);
    expect(await allDiagnostics(document.uri)).toHaveLength(1);
  });

  it('VueWithUnclosedReact.ucf: the splitter’s unclosed-block, and nothing from the <react> text', async () => {
    const document = await server.openTextDocument(UNCLOSED.filename, 'ucf');
    const diagnostics = await allDiagnostics(document.uri);
    expect(diagnostics.map(({source, code}) => ({source, code}))).toEqual([{source: 'multifront', code: 'unclosed-block'}]);
  });

  describe('Counter.ucf: one answer per <style> block, Vue’s own style codes left out', () => {
    const needle = 'color: rgb(120, 40, 160);';
    const source = COUNTER.source.replace(needle, `${needle}\n  colr: red;`);

    it('a CSS error in <style scoped> is one diagnostic', async () => {
      const document = await server.openUntitledDocument('ucf', source);
      const diagnostics = await allDiagnostics(document.uri);
      const colr = source.indexOf('colr');
      expect(diagnostics.map(({range}) => document.offsetAt(range.start))).toEqual([colr]);
    });

    it('a hover on a property has its docs once', async () => {
      const document = await server.openUntitledDocument('ucf', source);
      const hover = await server.sendHoverRequest(document.uri, document.positionAt(source.indexOf(needle) + 1));
      expect(hover?.contents).toMatchObject({kind: 'markdown'});
      const {value} = hover!.contents as {value: string};
      const firstLine = value.split('\n')[0]!;
      expect(firstLine).not.toBe('');
      expect(value.split(firstLine)).toHaveLength(2);
    });
  });
});
