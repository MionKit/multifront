// A `.ts` importer picking svelte gets `Card.ucf.svelte.ts`: svelte2tsx's script, a real Svelte `Component`.
// The bundled plugin's own checks are in bundle.spec.ts.
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {loadSvelteCompiler, loadVueCompiler} from '@multifront/core';
import {createUcfLanguagePlugin, EDITOR_BLOCK_KINDS, getTypesScript, resolveUcfImport} from '@multifront/language-tools';
import {createLanguage} from '@volar/language-core';
import type {VirtualCode} from '@volar/language-core';
import typescript from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, readComponent} from '../fixtures/index.ts';
import {edit, PLUGIN} from './lib/cases.ts';
import {locate, open, startTsserver} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';

const APP_DIR = join(FIXTURES_DIR, 'apps', 'svelte-vite');
const MAIN = readComponent(join('..', 'apps', 'svelte-vite', 'src', 'main.ts'));
const PANEL = readComponent('Panel.ucf');
const PANEL_ITEM = readComponent('PanelItem.ucf');
const NO_STYLE = readComponent('svelte/NoStyle.ucf');
const IMPORT_MOUNT = "import {mount} from 'svelte';";
const SVELTE_PROPS = '{ heading: string; children?: Snippet }';
const RENDER = '{@render children?.()}';
const svelteCompiler = loadSvelteCompiler(FIXTURES_DIR);
const compiler = loadVueCompiler(FIXTURES_DIR);
const fromLanguageTools = createRequire(createRequire(import.meta.url).resolve('@multifront/language-tools'));
const INSTALLED_SHIMS = dirname(fromLanguageTools.resolve('svelte2tsx/package.json'));
const SHIMS = ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts'];

const quickInfo = (server: Tsserver, {filename, source}: Component, needle: string, shift = 0) =>
  server.request<TsQuickInfo>('quickinfo', {file: filename, ...locate(source, needle, shift)});

describe('tsserver with our plugin: a .ts file picking svelte gets Card.ucf.svelte.ts', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    await open(server, [MAIN, PANEL]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  // Lines added after the imports, with `ComponentProps` imported.
  async function withUses(uses: string, check: (edited: Component) => Promise<void>): Promise<void> {
    const added = `import {mount, type ComponentProps} from 'svelte';\n${uses}`;
    const revert = await edit(server, MAIN, IMPORT_MOUNT, added);
    try {
      await check({...MAIN, source: MAIN.source.replace(IMPORT_MOUNT, added)});
    } finally {
      await revert();
    }
  }

  it('main.ts as written has no error', async () => {
    expect(await server.diagnostics(MAIN.filename)).toEqual([]);
  });

  it("Panel is a Svelte Component with a string heading, Counter's start a number", async () => {
    const uses = [
      'const picked = Panel;',
      "type Heading = ComponentProps<typeof Panel>['heading'];",
      "type Start = ComponentProps<typeof Counter>['start'];",
    ].join('\n');
    await withUses(uses, async (edited) => {
      expect((await quickInfo(server, edited, 'const picked', 6)).displayString).toMatch(/^const picked: Component</);
      expect((await quickInfo(server, edited, 'type Heading', 5)).displayString).toBe('type Heading = string');
      expect((await quickInfo(server, edited, 'type Start', 5)).displayString).toBe('type Start = number | undefined');
      expect(await server.diagnostics(MAIN.filename)).toEqual([]);
    });
  });

  it('mount(Panel, {props: {heading: 1}}) is one error, at heading', async () => {
    await withUses('mount(Panel, {target: document.body, props: {heading: 1}});', async ({source}) => {
      const diagnostics = await server.diagnostics(MAIN.filename);
      expect(diagnostics.map(({code, start, end}) => ({code, start, end}))).toEqual([
        {code: 2322, start: locate(source, 'heading: 1'), end: locate(source, 'heading: 1', 'heading'.length)},
      ]);
    });
  });

  it('definition on Panel lands in Panel.ucf', async () => {
    const definitions = await server.request<TsDefinitions>('definition', {
      file: MAIN.filename,
      ...locate(MAIN.source, 'mount(Panel', 'mount('.length),
    });
    expect(definitions.map(({file}) => file)).toEqual([PANEL.filename]);
  });

  it("an import in Panel.ucf's <svelte> block gets PanelItem's Svelte type", async () => {
    const revert = await edit(server, PANEL, SVELTE_PROPS, SVELTE_PROPS.replace('string', 'typeof PanelItem'));
    try {
      await withUses("type Heading = ComponentProps<typeof Panel>['heading'];", async (edited) => {
        // React's PanelItem would be its function, `({ label }: { label: string }) => …`.
        expect((await quickInfo(server, edited, 'type Heading', 5)).displayString).toMatch(/^type Heading = Component</);
      });
    } finally {
      await revert();
    }
  });

  it("while Panel.ucf's markup has an unclosed brace, main.ts keeps Panel's types and the block maps nothing", async () => {
    const binding = 'let { heading';
    const before = await quickInfo(server, PANEL, binding, 'let { '.length);
    expect(before.displayString).toBe('let heading: string');
    const revert = await edit(server, PANEL, RENDER, RENDER.slice(0, -1));
    try {
      await withUses("type Heading = ComponentProps<typeof Panel>['heading'];", async (edited) => {
        expect((await quickInfo(server, edited, 'type Heading', 5)).displayString).toBe('type Heading = string');
        expect(await server.diagnostics(MAIN.filename)).toEqual([]);
      });
      // The edit is after `heading`: a mapping kept from the last script would still answer here.
      await expect(quickInfo(server, PANEL, binding, 'let { '.length)).rejects.toThrow('No content available');
    } finally {
      await revert();
    }
    expect(await quickInfo(server, PANEL, binding, 'let { '.length)).toEqual(before);
  });
});

describe('getTypesScript for the svelte target', () => {
  const panelScript = () => getTypesScript(PANEL.filename, PANEL.source, 'svelte', {svelteCompiler, compiler});

  it('renames $style in the block and declares the class map it reads', () => {
    const {code, ext} = panelScript()!;
    expect(ext).toBe('.ts');
    expect(code).toContain('${__ucfStyle.title}');
    expect(code).not.toContain('$style');
    expect(code).toContain('declare const __ucfStyle: {readonly title: string};');
  });

  it("references svelte2tsx's shims in the installed package", () => {
    const references = [...panelScript()!.code.matchAll(/^\/\/\/ <reference path="(.*)" \/>$/gm)].map(([, path]) => path);
    expect(references).toEqual(SHIMS.map((name) => join(INSTALLED_SHIMS, name)));
  });

  it('has no script without the Svelte compiler', () => {
    expect(getTypesScript(PANEL.filename, PANEL.source, 'svelte', {compiler})).toBeUndefined();
  });

  it('a script Svelte cannot parse still gets one, unrenamed; markup svelte2tsx cannot read gets none', () => {
    const scriptError = readComponent('svelte/errors/ImportParseError.ucf');
    const types = getTypesScript(scriptError.filename, scriptError.source, 'svelte', {svelteCompiler})!;
    expect(types.code).toContain('export default ImportParseError__SvelteComponent_;');
    expect(types.code).not.toContain('__ucfStyle');
    const markupError = readComponent('svelte/errors/UnclosedBrace.ucf');
    expect(getTypesScript(markupError.filename, markupError.source, 'svelte', {svelteCompiler})).toBeUndefined();
  });

  it("resolves the block's own import to PanelItem.ucf.svelte.ts", () => {
    const containingFile = `${PANEL.filename}.svelte.ts`;
    const sourceFile = typescript.createSourceFile(containingFile, panelScript()!.code, typescript.ScriptTarget.ESNext, true);
    const literal = sourceFile.statements
      .filter(typescript.isImportDeclaration)
      .map(({moduleSpecifier}) => moduleSpecifier)
      .find((specifier) => typescript.isStringLiteral(specifier) && specifier.text === './PanelItem.ucf');
    if (!literal || !typescript.isStringLiteral(literal)) throw new Error('no ./PanelItem.ucf import in the script');
    const compilerOptions = {module: typescript.ModuleKind.Preserve, moduleResolution: typescript.ModuleResolutionKind.Bundler};
    const options = {compilerOptions, host: typescript.sys, getSplit: () => undefined};
    const {resolvedModule, target, error} = resolveUcfImport(typescript, literal, containingFile, options, sourceFile);
    expect({resolvedFileName: resolvedModule?.resolvedFileName, target, error}).toEqual({
      resolvedFileName: `${PANEL_ITEM.filename}.svelte.ts`,
      target: 'svelte',
      error: undefined,
    });
  });

  it('is the svelte code tsserver serves: TypeScript for a lang="ts" block, JavaScript without', () => {
    const language = createLanguage([createUcfLanguagePlugin({svelteCompiler, compiler})], new Map(), () => {});
    const kind = EDITOR_BLOCK_KINDS.find(({tag}) => tag === 'svelte')!;
    for (const [{filename, source}, scriptKind] of [
      [PANEL, typescript.ScriptKind.TS],
      [NO_STYLE, typescript.ScriptKind.JS],
    ] as const) {
      const script = language.scripts.set(filename, typescript.ScriptSnapshot.fromString(source))!;
      const code = script.generated!.embeddedCodes.get('svelte')!;
      // Then the markup code, for the language server's HTML service.
      const svelteIds = script.generated!.root.embeddedCodes!.map(({id}) => id).filter((id) => id.startsWith('svelte'));
      expect(svelteIds).toEqual(['svelte', 'svelte_markup']);
      const types = getTypesScript(filename, source, 'svelte', {svelteCompiler, compiler})!;
      expect(code.snapshot.getText(0, code.snapshot.getLength())).toBe(types.code);
      expect(code.mappings).toEqual(types.mappings);
      expect(kind.serviceScript!(code)?.scriptKind).toBe(scriptKind);
    }
  });
});

describe('createUcfLanguagePlugin for the svelte target', () => {
  it('the language plugin keeps the last script that built, mapped nowhere, until its script is deleted', () => {
    const language = createLanguage([createUcfLanguagePlugin({svelteCompiler, compiler})], new Map(), () => {});
    const svelteCode = (source: string) =>
      language.scripts.set(PANEL.filename, typescript.ScriptSnapshot.fromString(source))!.generated!.embeddedCodes.get('svelte');
    const text = ({snapshot}: VirtualCode) => snapshot.getText(0, snapshot.getLength());
    const broken = PANEL.source.replace(RENDER, RENDER.slice(0, -1));
    const good = svelteCode(PANEL.source)!;
    expect(good.mappings).not.toEqual([]);
    for (const source of [broken, `${broken}\n`]) {
      const kept = svelteCode(source)!;
      expect({text: text(kept), mappings: kept.mappings}).toEqual({text: text(good), mappings: []});
    }
    language.scripts.delete(PANEL.filename);
    expect(svelteCode(broken)).toBeUndefined();
  });
});
