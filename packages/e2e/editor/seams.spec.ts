// Milestone 2 QA: paths that cross steps, each step's output fed through the next step's real tools.
import {join} from 'node:path';
import {loadVueCompiler, splitBlocks} from '@multifront/core';
import {createUcfLanguagePlugin, getTypesScript, resolveUcfImport} from '@multifront/language-tools';
import {createLanguage} from '@volar/language-core';
import ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EXPECTED_IMPORTS} from '../fixtures/apps/imports/expected.ts';
import {componentPath, FIXTURES_DIR, listComponents, readComponent} from '../fixtures/index.ts';
import {APP_DIR, CARD, onLine, PLUGIN, readApp} from './lib/cases.ts';
import {startLanguageServer} from './lib/lsp.ts';
import type {LanguageServer} from './lib/lsp.ts';
import {locate, open, startTsserver} from './lib/tsserver.ts';
import type {TsDefinitions, Tsserver} from './lib/tsserver.ts';

const compiler = loadVueCompiler(FIXTURES_DIR);
const NAMES = [...listComponents(), ...listComponents('invalid'), ...listComponents('langs'), ...listComponents('editor')];

// 2.7's table through 2.8's plugin: the `.ucf` importers of the imports app, served by tsserver.
describe('the .ucf rows of expected.ts through tsserver with our plugin', () => {
  const ROWS = EXPECTED_IMPORTS.filter(({file}) => file.endsWith('.ucf'));
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    await open(server, [...new Set(ROWS.map(({file}) => file))].map(readApp));
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('covers both in-block importers', () => {
    expect(new Set(ROWS.map(({file}) => file))).toEqual(new Set(['src/Showcase.ucf', 'src/BlockAttribute.ucf']));
  });

  it.each(ROWS)('$file line $line: $expect', async (row) => {
    const {filename, source} = readApp(row.file);
    const lineText = source.split('\n')[row.line - 1]!;
    const at = locate(source, lineText, lineText.indexOf(`'${row.specifier}'`));
    const diagnostics = onLine(await server.diagnostics(filename), row.line);
    if (!('rule' in row)) {
      expect(diagnostics).toMatchObject([{code: row.expect, source: 'multifront', category: 'error', start: at}]);
      return;
    }
    expect(row.expect).toBe('react');
    expect(diagnostics).toEqual([]);
    const definitions = await server.request<TsDefinitions>('definition', {file: filename, line: at.line, offset: at.offset + 1});
    expect(definitions.map(({file}) => file)).toEqual([CARD.filename]);
  });
});

// 2.5's public helper and 2.4's language plugin: M5 emits `.d.ts` files from what the editor shows.
describe('getTypesScript gives the react code the language plugin serves', () => {
  const language = createLanguage([createUcfLanguagePlugin({compiler})], new Map(), () => {});

  it.each(NAMES)('%s', (name) => {
    const {filename, source} = readComponent(name);
    const script = language.scripts.set(filename, ts.ScriptSnapshot.fromString(source))!;
    const react = script.generated!.embeddedCodes.get('react');
    const types = getTypesScript(filename, source, 'react', {compiler});
    expect(types === undefined).toBe(react === undefined);
    if (!react || !types) return;
    expect(types.code).toBe(react.snapshot.getText(0, react.snapshot.getLength()));
    expect(types.mappings).toEqual(react.mappings);
  });
});

// 2.5's named module through 2.9's tsserver: `classes` is typed and jumps to its class like `$style` does.
describe('a named style module in tsserver: Button.ucf', () => {
  const BUTTON = readComponent('Button.ucf');
  // The <react> use; the <vue> and <svelte> ones come first in the file.
  const ACCESS = '{`button ${classes.';
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: componentPath('editor'), plugins: [PLUGIN]});
    await open(server, [BUTTON]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('completion after classes. lists primary', async () => {
    const at = locate(BUTTON.source, ACCESS, ACCESS.length);
    const completions = await server.request<ts.server.protocol.CompletionInfo>('completionInfo', {file: BUTTON.filename, ...at});
    expect(completions.entries.map(({name}) => name)).toContain('primary');
  });

  it('definition on classes.primary lands on .primary', async () => {
    const at = locate(BUTTON.source, ACCESS, ACCESS.length + 1);
    const definitions = await server.request<TsDefinitions>('definition', {file: BUTTON.filename, ...at});
    expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
      {file: BUTTON.filename, start: locate(BUTTON.source, '.primary {', 1)},
    ]);
  });
});

// 2.8's resolver as a public function, the way M7's mf-tsc calls it: no open buffers.
describe('resolveUcfImport with no open buffer', () => {
  const IMPORT_ERRORS = readComponent('editor/ImportErrors.ucf');

  function literalOf(specifier: string): ts.StringLiteralLike {
    const sourceFile = ts.createSourceFile(IMPORT_ERRORS.filename, IMPORT_ERRORS.source, ts.ScriptTarget.Latest, true);
    let found: ts.StringLiteralLike | undefined;
    const visit = (node: ts.Node): void => {
      if (!found && ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (node.moduleSpecifier.text === specifier) found = node.moduleSpecifier;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!found) throw new Error(`${specifier} not imported`);
    return found;
  }

  it('splits the imported file itself: a file without the block is missing-target-block', () => {
    const resolution = resolveUcfImport(ts, literalOf('../imports/VueOnly.ucf'), IMPORT_ERRORS.filename, {
      compilerOptions: {module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler},
      host: ts.sys,
      getSplit: () => undefined,
    });
    expect(resolution.resolvedModule?.resolvedFileName).toBe(componentPath('imports/VueOnly.ucf'));
    expect(resolution.error).toEqual({
      code: 'missing-target-block',
      message: '../imports/VueOnly.ucf has no <react> block; ImportErrors.ucf imports it as react',
    });
  });
});

// Goal: "Inside <style>: CSS and SCSS ... errors". 2.4's style codes through 2.6's server, mapped back to the .ucf file.
describe('the language server reports CSS and SCSS errors inside <style>', () => {
  let server: LanguageServer;

  beforeAll(async () => {
    server = await startLanguageServer(join(FIXTURES_DIR, 'components'));
  });

  afterAll(async () => {
    await server?.stop();
  });

  // Every diagnostic not ours: which service sent it, and whether it starts inside the first <style>.
  async function styleErrors(document: Awaited<ReturnType<LanguageServer['openTextDocument']>>, source: string) {
    const report = await server.sendDocumentDiagnosticRequest(document.uri);
    const items = 'items' in report ? report.items : [];
    const {contentStart, contentEnd} = splitBlocks(source, 'Inline.ucf').styles[0]!;
    return items
      .filter(({source: from}) => from !== 'multifront')
      .map(({source: from, range}) => {
        const start = document.offsetAt(range.start);
        return {from, inStyle: start >= contentStart && start < contentEnd};
      });
  }

  it('invalid/ScssSyntaxError.ucf: an scss error inside its <style>', async () => {
    const {filename, source} = readComponent('invalid/ScssSyntaxError.ucf');
    const document = await server.openTextDocument(filename, 'ucf');
    const errors = await styleErrors(document, source);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toEqual(errors.map(() => ({from: 'scss', inStyle: true})));
  });

  it('an unsaved buffer with a broken CSS declaration: a css error inside its <style>', async () => {
    const source =
      '<react>\n  export default function A() { return <p /> }\n</react>\n\n<style>\n.a { color: red; ; : }\n</style>\n';
    const document = await server.openUntitledDocument('ucf', source);
    const errors = await styleErrors(document, source);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toEqual(errors.map(() => ({from: 'css', inStyle: true})));
  });
});
