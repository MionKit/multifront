// The <svelte> block in the editor: tsserver serves svelte2tsx's script, mapped back through its source map and the
// `$style` rename's; the language server adds our check diagnostics.
import {readdirSync} from 'node:fs';
import {checkBlocks, loadSvelteCompiler, loadVueCompiler, splitBlocks} from '@multifront/core';
import {getTypesScript, TSSERVER_CODES} from '@multifront/language-tools';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {componentPath, FIXTURES_DIR, readComponent} from '../fixtures/index.ts';
import {CARD, edit, multifrontDiagnostics, PLUGIN} from './lib/cases.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {offsetAt, open, startTsserver, tsLocation} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsLocation, TsQuickInfo, Tsserver} from './lib/tsserver.ts';

const PANEL = readComponent('Panel.front');
const PANEL_ITEM = readComponent('PanelItem.front');
const COUNTER = readComponent('Counter.front');
const COUNTER_CRLF = readComponent('vue/CounterCrlf.front');
const ATTR_IN_SVELTE = readComponent('svelte/imports/AttrInSvelte.front');
const TOP_LEVEL_STYLE = readComponent('svelte/errors/TopLevelStyle.front');
const COMPONENTS = readComponent('svelte/shapes/Components.front');
const ELEMENTS = readComponent('svelte/shapes/Elements.front');
const SHARED = [
  CARD,
  PANEL,
  PANEL_ITEM,
  COUNTER,
  COUNTER_CRLF,
  readComponent('imports/Icon.front'),
  readComponent('imports/UsesIcon.front'),
  readComponent('svelte/NoStyle.front'),
];

let tsserver: Tsserver;
let server: LanguageServer;

beforeAll(async () => {
  tsserver = startTsserver({cwd: componentPath(''), plugins: [PLUGIN]});
  // The fixtures sit in no tsconfig project: these options stand in for an app's.
  await tsserver.request('compilerOptionsForInferredProjects', {
    options: {strict: true, module: 'preserve', moduleResolution: 'bundler', target: 'es2022', jsx: 'react-jsx'},
  });
  await open(tsserver, [...SHARED, ATTR_IN_SVELTE, TOP_LEVEL_STYLE, COMPONENTS, ELEMENTS]);
  server = await startLanguageServer(componentPath(''));
});

afterAll(async () => {
  await server?.stop();
  await tsserver?.stop();
});

function svelteOffset({filename, source}: Component, needle: string, shift = 0): number {
  const block = splitBlocks(source, filename).targets.svelte!;
  const index = source.indexOf(needle, block.contentStart);
  if (index < 0 || index + needle.length > block.contentEnd) throw new Error(`${needle} not in the <svelte> block`);
  return index + shift;
}

const inSvelte = (component: Component, needle: string, shift = 0): TsLocation =>
  tsLocation(component.source, svelteOffset(component, needle, shift));

const quickInfo = (component: Component, needle: string, shift = 0) =>
  tsserver.request<TsQuickInfo>('quickinfo', {file: component.filename, ...inSvelte(component, needle, shift)});

const completions = async (component: Component, at: TsLocation) =>
  (await tsserver.request<ts.server.protocol.CompletionInfo>('completionInfo', {file: component.filename, ...at})).entries.map(
    ({name}) => name
  );

/** An unsaved edit of the block's first `needle`; the check gets the edited component. */
async function withEdit(component: Component, needle: string, newText: string, check: (edited: Component) => Promise<void>) {
  svelteOffset(component, needle);
  const revert = await edit(tsserver, component, needle, newText);
  try {
    await check({...component, source: component.source.replace(needle, newText)});
  } finally {
    await revert();
  }
}

async function diagnostics({filename, source}: Component) {
  return (await tsserver.diagnostics(filename)).map(({code, start, end}) => ({
    code,
    start: offsetAt(source, start),
    end: offsetAt(source, end),
  }));
}

describe('tsserver: TypeScript inside the <svelte> block', () => {
  it('hover on heading in {heading} shows string; definition lands on its $props() binding', async () => {
    const needle = '}">{heading}</h3>';
    const shift = '}">{'.length;
    expect((await quickInfo(PANEL, needle, shift)).displayString).toContain('heading: string');
    const definitions = await tsserver.request<TsDefinitions>('definition', {
      file: PANEL.filename,
      ...inSvelte(PANEL, needle, shift),
    });
    const binding = svelteOffset(PANEL, 'let { heading', 'let { '.length);
    expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
      {file: PANEL.filename, start: tsLocation(PANEL.source, binding)},
    ]);
  });

  it.each([COUNTER, COUNTER_CRLF])('$filename: hover on {count} shows number', async (component) => {
    expect((await quickInfo(component, 'count++}>{count}', 'count++}>{'.length)).displayString).toContain('count: number');
  });

  describe("Card.front's $style", () => {
    it('as written: no diagnostic', async () => {
      expect(await diagnostics(CARD)).toEqual([]);
    });

    it('$style.cardd is one TS2551, on cardd exactly', async () => {
      await withEdit(CARD, 'class={$style.card}', 'class={$style.cardd}', async (edited) => {
        const start = svelteOffset(edited, '$style.cardd', '$style.'.length);
        expect(await diagnostics(edited)).toEqual([{code: 2551, start, end: start + 'cardd'.length}]);
      });
    });

    it('completion right after $style. lists card', async () => {
      expect(await completions(CARD, inSvelte(CARD, '$style.card', '$style.'.length))).toContain('card');
    });

    it('while typing: completion after {$style.} lists card', async () => {
      await withEdit(CARD, 'class={$style.card}', 'class={$style.}', async (edited) => {
        expect(await completions(edited, inSvelte(edited, '$style.}', '$style.'.length))).toContain('card');
      });
    });

    it('while typing in the script: completion after $style. lists card', async () => {
      const needle = '= $props()';
      await withEdit(CARD, needle, `${needle}\n    const typed = $style.`, async (edited) => {
        expect(await completions(edited, inSvelte(edited, 'typed = $style.', 'typed = $style.'.length))).toContain('card');
      });
    });

    it('hover on $style shows the class map it is renamed to', async () => {
      expect((await quickInfo(CARD, '$style.card', 1)).displayString).toContain('__frontStyle: {');
    });

    it.each([
      {component: COMPONENTS, needle: '<Child {$style} />', shift: '<Child {'.length},
      {component: ELEMENTS, needle: 'classes = {$style}', shift: 'classes = {'.length},
    ])('hover on a shorthand use, $needle, shows its class map too', async ({component, needle, shift}) => {
      expect((await quickInfo(component, needle, shift + 1)).displayString).toMatch(/__frontStyle\d*: \{/);
    });

    it('definition on card lands on .card in <style module>', async () => {
      const definitions = await tsserver.request<TsDefinitions>('definition', {
        file: CARD.filename,
        ...inSvelte(CARD, '$style.card', '$style.'.length),
      });
      expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
        {file: CARD.filename, start: tsLocation(CARD.source, CARD.source.indexOf('.card {') + 1)},
      ]);
    });
  });

  describe('type errors in markup expressions', () => {
    it('{heading.toFixed(2)} is one TS2551, on toFixed', async () => {
      await withEdit(PANEL, '}">{heading}</h3>', '}">{heading.toFixed(2)}</h3>', async (edited) => {
        const start = svelteOffset(edited, 'toFixed');
        expect(await diagnostics(edited)).toEqual([{code: 2551, start, end: start + 'toFixed'.length}]);
      });
    });

    it("a number for PanelItem's string label is one TS2322, inside label={1}", async () => {
      const needle = '<PanelItem label="first item" />\n    {@render';
      await withEdit(PANEL, needle, needle.replace('"first item"', '{1}'), async (edited) => {
        const attribute = svelteOffset(edited, 'label={1}');
        const errors = await diagnostics(edited);
        expect(errors.map(({code}) => code)).toEqual([2322]);
        expect(errors[0]!.start).toBeGreaterThanOrEqual(attribute);
        expect(errors[0]!.end).toBeLessThanOrEqual(attribute + 'label={1}'.length);
      });
    });
  });

  it('definition on <PanelItem lands in PanelItem.front', async () => {
    const definitions = await tsserver.request<TsDefinitions>('definition', {
      file: PANEL.filename,
      ...inSvelte(PANEL, '<PanelItem label', 1),
    });
    expect(definitions.map(({file}) => file)).toEqual([PANEL_ITEM.filename]);
  });

  it.each(SHARED)('$filename as written: no diagnostic', async ({filename}) => {
    expect(await tsserver.diagnostics(filename)).toEqual([]);
  });

  it('AttrInSvelte.front: tsserver reports framework-in-block at each of its three specifiers', async () => {
    const specifier = "'../../imports/Icon.front'";
    const expected = [...ATTR_IN_SVELTE.source.matchAll(new RegExp(specifier, 'g'))].map(({index}) => ({
      code: 'framework-in-block',
      start: index,
      end: index + specifier.length,
    }));
    expect(expected).toHaveLength(3);
    const reported = (await diagnostics(ATTR_IN_SVELTE)).toSorted((one, other) => one.start - other.start);
    expect(reported).toEqual(expected);
  });

  it('TopLevelStyle.front: nothing from tsserver', async () => {
    expect(await tsserver.diagnostics(TOP_LEVEL_STYLE.filename)).toEqual([]);
  });
});

describe('the language server: our check diagnostics on the <svelte> block', () => {
  it('TopLevelStyle.front: style-inside-target, exactly as checkBlocks reports it', async () => {
    const {filename, source} = TOP_LEVEL_STYLE;
    const document = await server.openTextDocument(filename, 'front');
    const expected = checkBlocks(splitBlocks(source, filename)).map(({code, start, end}) => ({
      code,
      range: {start: document.positionAt(start), end: document.positionAt(end)},
    }));
    expect(expected.map(({code}) => code)).toEqual(['style-inside-target']);
    expect((await multifrontDiagnostics(server, document)).map(({code, range}) => ({code, range}))).toEqual(expected);
  });

  it('AttrInSvelte.front: no framework-in-block, tsserver reports it', async () => {
    expect(TSSERVER_CODES.has('framework-in-block')).toBe(true);
    const document = await server.openTextDocument(ATTR_IN_SVELTE.filename, 'front');
    expect(await multifrontDiagnostics(server, document)).toEqual([]);
  });
});

describe("the <svelte> script's mappings, over every fixture with a <svelte> block", () => {
  const svelteCompiler = loadSvelteCompiler(FIXTURES_DIR);
  const compiler = loadVueCompiler(FIXTURES_DIR);
  const names = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
    .filter((name) => name.endsWith('.front'))
    .map((name) => name.replaceAll('\\', '/'))
    .filter((name) => splitBlocks(readComponent(name).source, componentPath(name)).targets.svelte)
    .sort();

  it('finds the fixtures', () => {
    expect(names.length).toBeGreaterThan(60);
  });

  it.each(names)('%s: each mapping is the same text or a point, inside the block; a renamed class map is its $name', (name) => {
    const {filename, source} = readComponent(name);
    const types = getTypesScript(filename, source, 'svelte', {svelteCompiler, compiler});
    // svelte2tsx throws on markup even the loose parser cannot read, and on StyleInSvelte's `'<style>'` script string.
    if (!types) return expect(['svelte/errors/UnclosedBrace.front', 'invalid/StyleInSvelte.front']).toContain(name);
    const block = splitBlocks(source, filename).targets.svelte!;
    // Class name keys jump into <style> blocks: navigation only.
    const blockMappings = types.mappings.filter(({data}) => data.verification);
    expect(blockMappings.length).toBeGreaterThan(0);
    for (const {sourceOffsets, generatedOffsets, lengths, generatedLengths, data} of blockMappings) {
      const [from, at, length] = [sourceOffsets[0]!, generatedOffsets[0]!, lengths[0]!];
      expect(from).toBeGreaterThanOrEqual(block.contentStart);
      expect(from + length).toBeLessThanOrEqual(block.contentEnd);
      // A run of generated code: diagnostics in it land on the point it came from, nothing else.
      if (length === 0) {
        expect(data).toEqual({verification: true});
        continue;
      }
      const text = source.slice(from, from + length);
      const generated = types.code.slice(at, at + (generatedLengths?.[0] ?? length));
      if (generatedLengths)
        expect([text, generated]).toEqual([expect.stringMatching(/^\$\w+$/), expect.stringMatching(/^__front\w+$/)]);
      else expect(generated).toBe(text);
    }
  });
});
