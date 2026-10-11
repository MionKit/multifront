// The <vue> block as a .vue file: tsserver serves its TypeScript, the language server Vue's template services, which
// ask tsserver for types through the relay the extension runs.
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {componentPath, readComponent} from '../fixtures/index.ts';
import {diagnosticsOf, edit, PLUGIN} from './lib/cases.ts';
import {relayTsserver, startLanguageServer, TSDK} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {locate, offsetAt, open, startTsserver, tsLocation} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';

const COUNTER = readComponent('Counter.ucf');
const COUNTER_CRLF = readComponent('vue/CounterCrlf.ucf');
const USES_ICON = readComponent('imports/UsesIcon.ucf');
const ATTR_INSIDE = readComponent('vue/AttrInside.ucf');

let tsserver: Tsserver;
let server: LanguageServer;

beforeAll(async () => {
  tsserver = startTsserver({cwd: componentPath(''), plugins: [PLUGIN]});
  // The fixtures sit in no tsconfig project: these options stand in for an app's.
  await tsserver.request('compilerOptionsForInferredProjects', {
    options: {strict: true, module: 'preserve', moduleResolution: 'bundler', target: 'es2022', jsx: 'react-jsx'},
  });
  await open(tsserver, [COUNTER, COUNTER_CRLF, USES_ICON, ATTR_INSIDE]);
  server = await startLanguageServer(componentPath(''), {initializationOptions: {typescript: {tsdk: TSDK}}});
  relayTsserver(server, tsserver);
});

afterAll(async () => {
  await server?.stop();
  await tsserver?.stop();
});

async function diagnosticsAfter(component: Component, needle: string, newText: string) {
  const revert = await edit(tsserver, component, needle, newText);
  try {
    return (await tsserver.diagnostics(component.filename)).map(({code, start, end, text}) => ({code, start, end, text}));
  } finally {
    await revert();
  }
}

function labels(list: Awaited<ReturnType<LanguageServer['sendCompletionRequest']>>): string[] {
  return list?.items.map(({label}) => label) ?? [];
}

describe('tsserver: TypeScript inside the <vue> block', () => {
  it.each([COUNTER, COUNTER_CRLF])(
    '$filename: hover on a <script setup> variable in the template shows its type',
    async ({filename, source}) => {
      const info = await tsserver.request<TsQuickInfo>('quickinfo', {file: filename, ...locate(source, '{{ count }}', 3)});
      expect(info.displayString).toContain('count: number');
    }
  );

  it.each([COUNTER, COUNTER_CRLF])(
    '$filename: definition from the template lands on its declaration',
    async ({filename, source}) => {
      const definitions = await tsserver.request<TsDefinitions>('definition', {
        file: filename,
        ...locate(source, '{{ count }}', 3),
      });
      expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
        {file: filename, start: tsLocation(source, source.indexOf('count = ref'))},
      ]);
    }
  );

  it('completion inside {{ }} lists the variable', async () => {
    const at = locate(COUNTER.source, '{{ count }}', 3);
    const {entries} = await tsserver.request<ts.server.protocol.CompletionInfo>('completionInfo', {
      file: COUNTER.filename,
      ...at,
    });
    expect(entries.map(({name}) => name)).toContain('count');
  });

  it('$style.button is no error, $style.buton is one TS2551', async () => {
    expect(await tsserver.diagnostics(COUNTER.filename)).toEqual([]);
    const errors = await diagnosticsAfter(COUNTER, '$style.button', '$style.buton');
    expect(errors.map(({code}) => code)).toEqual([2551]);
  });

  describe('UsesIcon.ucf: its <vue> block imports the Vue Icon (in-block rule)', () => {
    it('has no diagnostic as written', async () => {
      expect(await tsserver.diagnostics(USES_ICON.filename)).toEqual([]);
    });

    it("a string for Icon's number prop is one TS2322, at that attribute", async () => {
      const [needle, attribute] = ['<Icon />', `:size="'big'"`];
      const errors = await diagnosticsAfter(USES_ICON, needle, `<Icon ${attribute} />`);
      const edited = USES_ICON.source.replace(needle, `<Icon ${attribute} />`);
      const start = edited.indexOf(attribute);
      expect(errors.map(({code}) => code)).toEqual([2322]);
      const at = offsetAt(edited, errors[0]!.start);
      expect(at).toBeGreaterThanOrEqual(start);
      expect(at).toBeLessThan(start + attribute.length);
    });
  });

  it('an import of a file with no <vue> block from the <vue> block is missing-target-block', async () => {
    const errors = await diagnosticsAfter(USES_ICON, "import Icon from './Icon.ucf'", "import Icon from './ReactOnly.ucf'");
    expect(errors.map(({code, text}) => ({code, text}))).toEqual([
      {code: 'missing-target-block', text: './ReactOnly.ucf has no <vue> block; UsesIcon.ucf imports it as vue'},
    ]);
  });

  it("our handler answers Vue's directive request with the file's directives", async () => {
    const command = '_multifront:getComponentDirectives';
    expect(await tsserver.request<string[]>(command, [COUNTER.filename])).toEqual(expect.arrayContaining(['vShow', 'vIf']));
  });

  it('AttrInside.ucf: tsserver reports framework-in-block at both specifiers', async () => {
    const {source} = ATTR_INSIDE;
    const specifier = "'../imports/Icon.ucf'";
    const first = source.indexOf(specifier);
    const second = source.indexOf(specifier, first + 1);
    const diagnostics = (await tsserver.diagnostics(ATTR_INSIDE.filename)).map(({code, start}) => ({code, start}));
    diagnostics.sort((one, other) => one.start.line - other.start.line);
    expect(diagnostics).toEqual([
      {code: 'framework-in-block', start: tsLocation(source, first)},
      {code: 'framework-in-block', start: tsLocation(source, second)},
    ]);
  });
});

describe("the language server: Vue's template services, answered by tsserver", () => {
  it('completion at <sp lists span, div and the file itself', async () => {
    const document = await server.openTextDocument(COUNTER.filename, 'ucf');
    const [needle, newText] = ['<div class="counter">', '<div class="counter">\n      <sp'];
    const start = COUNTER.source.indexOf(needle);
    const range = {start: document.positionAt(start), end: document.positionAt(start + needle.length)};
    const revertTsserver = await edit(tsserver, COUNTER, needle, newText);
    const edited = await server.updateTextDocument(document.uri, [{range, newText}]);
    try {
      const list = await server.sendCompletionRequest(document.uri, edited.positionAt(start + newText.length));
      expect(labels(list)).toEqual(expect.arrayContaining(['span', 'div', 'Counter']));
    } finally {
      const end = edited.positionAt(start + newText.length);
      await server.updateTextDocument(document.uri, [{range: {start: range.start, end}, newText: needle}]);
      await revertTsserver();
    }
  });

  it('completion before an attribute lists :id, @click and v-if', async () => {
    const document = await server.openTextDocument(COUNTER.filename, 'ucf');
    const at = document.positionAt(COUNTER.source.indexOf('class="label"'));
    expect(labels(await server.sendCompletionRequest(document.uri, at))).toEqual(
      expect.arrayContaining([':id', '@click', 'v-if'])
    );
  });

  it("completion before the end of a component tag lists its props: Icon's :size", async () => {
    const document = await server.openTextDocument(USES_ICON.filename, 'ucf');
    const at = document.positionAt(USES_ICON.source.indexOf('<Icon />') + '<Icon '.length);
    expect(labels(await server.sendCompletionRequest(document.uri, at))).toContain(':size');
  });

  it('class="counter" links to .counter in <style scoped>', async () => {
    const document = await server.openTextDocument(COUNTER.filename, 'ucf');
    const links = await server.sendDocumentLinkRequest(document.uri);
    const use = COUNTER.source.indexOf('counter"');
    const rule = tsLocation(COUNTER.source, COUNTER.source.indexOf('.counter {'));
    expect(links?.map(({range, target}) => ({start: document.offsetAt(range.start), target: target?.split('#')[1]}))).toEqual([
      {start: use, target: `L${rule.line}%2C${rule.offset}-L${rule.line}%2C${rule.offset + '.counter'.length}`},
    ]);
  });

  it('an SFC error in the <vue> block, a <template> never closed, is reported at its tag', async () => {
    const source = COUNTER.source.replace('  </template>\n</vue>', '\n</vue>');
    const document = await server.openUntitledDocument('ucf', source);
    const errors = (await diagnosticsOf(server, document)).filter(({source: from}) => from === 'vue');
    const tag = source.indexOf('<template>');
    expect(errors.map(({message, range}) => ({message, start: document.offsetAt(range.start)}))).toEqual([
      {message: 'Element is missing end tag.', start: tag},
    ]);
  });

  // Completion items are merged by label, a hover's contents are not: Vue's css plugin would show its docs twice.
  it("in <style scoped>, completion lists color once and its hover has its docs once: Vue's css plugin is left out", async () => {
    const document = await server.openTextDocument(COUNTER.filename, 'ucf');
    const at = document.positionAt(COUNTER.source.indexOf('color: rgb') + 2);
    expect(labels(await server.sendCompletionRequest(document.uri, at)).filter((label) => label === 'color')).toEqual(['color']);
    const hover = await server.sendHoverRequest(document.uri, at);
    const {value} = hover!.contents as {value: string};
    const firstLine = value.split('\n')[0]!;
    expect(firstLine).toContain('color');
    expect(value.split(firstLine)).toHaveLength(2);
  });

  it('AttrInside.ucf: framework-in-block is left to tsserver', async () => {
    const document = await server.openTextDocument(ATTR_INSIDE.filename, 'ucf');
    expect(await diagnosticsOf(server, document)).toEqual([]);
  });

  // Last: a plugin that throws (a plain root has no `ir`) logs a warning.
  it('logged no warning or error', () => {
    expect(server.log.filter(({type}) => type <= 2)).toEqual([]);
  });
});
