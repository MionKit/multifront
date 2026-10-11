import {copyFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type * as ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {readComponent} from '../fixtures/index.ts';
import {
  APP,
  APP_DIR,
  appTsxCases,
  CARD,
  codesOnLine,
  edit,
  expectCardPropError,
  MIXED,
  MIXED_LINES,
  onLine,
  PLUGIN,
  readApp,
} from './lib/cases.ts';
import {E2E_DIR, inBlock, locate, open, startTsserver} from './lib/tsserver.ts';
import type {Component, TsDefinitions, TsQuickInfo, Tsserver} from './lib/tsserver.ts';

type Completions = ts.server.protocol.CompletionInfo;

const TYPE_ERROR = readComponent('editor/TypeError.ucf');
const BUTTON = readComponent('Button.ucf');
const CARD_SPECIFIER = '../../../components/Card.ucf';
const STYLE_ACCESS = 'className={$style.';
// `$style`, and a named module; Button's <react> use comes after its <vue> and <svelte> ones.
const MODULE_ACCESS = [
  {component: CARD, access: STYLE_ACCESS, key: 'card'},
  {component: BUTTON, access: '{`button ${classes.', key: 'primary'},
];
const REACT_SIGNATURE = 'Card({ title }: { title: string })';

describe('the TypeScript plugin in tsserver, on the imports app', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    await open(server, [APP, MIXED, readApp('src/lazy.ts'), CARD, BUTTON, TYPE_ERROR]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  appTsxCases(() => server);

  describe('mixed.ts: one specifier imported as vue, then as react', () => {
    it.each(['VueCard', 'ReactCard'])('%s gets the React types of the last import', async (name) => {
      const info = await server.request<TsQuickInfo>('quickinfo', {
        file: MIXED.filename,
        ...locate(MIXED.source, `import ${name}`, 7),
      });
      expect(info.displayString).toContain('title: string');
    });

    it('the second import has the warning naming the fix; the first only its own error', async () => {
      const diagnostics = await server.diagnostics(MIXED.filename);
      const [vue, react] = MIXED_LINES;
      expect(codesOnLine(diagnostics, vue)).toEqual(['target-not-built']);
      const [warning, ...rest] = onLine(diagnostics, react);
      expect(rest).toEqual([]);
      const start = locate(MIXED.source, `'${CARD_SPECIFIER}' with {framework: 'react'}`);
      expect(warning).toMatchObject({code: 'mixed-frameworks', source: 'multifront', category: 'warning', start});
      expect(warning!.text).toContain('imported as vue and as react');
      expect(warning!.text).toContain('re-export file');
    });

    it("the warning hides none of TypeScript's own errors, and counts imports TypeScript cannot find", async () => {
      const lines = [
        `import {Nope} from '${CARD_SPECIFIER}' with {framework: 'react'};`,
        "import GoneVue from './Gone.ucf' with {framework: 'vue'};",
        "import GoneReact from './Gone.ucf' with {framework: 'react'};",
      ];
      const last = MIXED.source.trimEnd().split('\n').at(-1)!;
      const edited = MIXED.source.replace(last, [last, ...lines].join('\n'));
      const revert = await edit(server, MIXED, last, [last, ...lines].join('\n'));
      try {
        const diagnostics = await server.diagnostics(MIXED.filename);
        const [nope, goneVue, goneReact] = lines.map((line) => locate(edited, line).line);
        const nopeCodes = codesOnLine(diagnostics, nope!);
        expect(nopeCodes).toContain('mixed-frameworks');
        expect(nopeCodes.filter((code) => typeof code === 'number')).toHaveLength(1);
        expect(codesOnLine(diagnostics, goneVue!)).toEqual([2307]);
        expect(codesOnLine(diagnostics, goneReact!).sort()).toEqual([2307, 'mixed-frameworks']);
      } finally {
        await revert();
      }
    });
  });

  it('a missing block beats the missing types: one missing-target-block naming both files', async () => {
    const lazy = readApp('src/lazy.ts');
    const specifier = `'${CARD_SPECIFIER}'`;
    const revert = await edit(server, lazy, specifier, "'../../../components/imports/VueOnly.ucf'");
    try {
      const diagnostics = await server.diagnostics(lazy.filename);
      expect(diagnostics).toMatchObject([
        {code: 'missing-target-block', category: 'error', start: locate(lazy.source, specifier)},
      ]);
      expect(diagnostics[0]!.text).toBe(
        '../../../components/imports/VueOnly.ucf has no <svelte> block; lazy.ts imports it as svelte'
      );
    } finally {
      await revert();
    }
  });

  describe("inside Card.ucf's <react>, and Button.ucf's named module", () => {
    it.each(MODULE_ACCESS)('completion after $access lists $key', async ({component, access, key}) => {
      const at = locate(component.source, access, access.length);
      const completions = await server.request<Completions>('completionInfo', {file: component.filename, ...at});
      expect(completions.entries.map(({name}) => name)).toContain(key);
    });

    it('hover on title shows string', async () => {
      const info = await server.request<TsQuickInfo>('quickinfo', {
        file: CARD.filename,
        ...locate(CARD.source, '<h2>{title}', 5),
      });
      expect(info.displayString).toContain('title: string');
    });

    it.each(MODULE_ACCESS)('definition on the $key key lands on .$key', async ({component, access, key}) => {
      const at = locate(component.source, access, access.length + 1);
      const definitions = await server.request<TsDefinitions>('definition', {file: component.filename, ...at});
      expect(definitions.map(({file, start}) => ({file, start}))).toEqual([
        {file: component.filename, start: locate(component.source, `.${key} {`, 1)},
      ]);
    });

    it('TypeError.ucf reports its type error at its .ucf line and column', async () => {
      const diagnostics = await server.diagnostics(TYPE_ERROR.filename);
      expect(diagnostics).toMatchObject([{code: 2322, category: 'error', start: locate(TYPE_ERROR.source, 'label:')}]);
    });
  });

  describe('one program for .ucf and .tsx files', () => {
    it('an unsaved prop rename in Card.ucf makes App.tsx report the old prop at once', async () => {
      await expectCardPropError(server, CARD, REACT_SIGNATURE, 'Card({ heading }: { heading: string })');
    });

    it('rename on the prop in Card.ucf also edits App.tsx', async () => {
      const at = locate(CARD.source, REACT_SIGNATURE, 'Card({ title }: { '.length + 1);
      const body = await server.request<ts.server.protocol.RenameResponseBody>('rename', {file: CARD.filename, ...at});
      expect(body.info.canRename).toBe(true);
      expect(body.locs.map(({file}) => file)).toEqual(expect.arrayContaining([CARD.filename, APP.filename]));
    });

    it('references from App.tsx list the use inside <react>', async () => {
      const at = locate(APP.source, 'title=', 1);
      const body = await server.request<ts.server.protocol.ReferencesResponseBody>('references', {file: APP.filename, ...at});
      expect(body.refs.some((ref) => inBlock(CARD, 'react', ref))).toBe(true);
    });
  });
});

describe('the TypeScript plugin in a project outside the repo: no @vue/compiler-sfc, svelte by default', () => {
  // Outside the repo on purpose: inside it, the root node_modules has the compiler.
  let dir: string;
  let server: Tsserver;
  let card: Component;
  let importer: Component;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'multifront-no-vue-'));
    const compilerOptions = {
      jsx: 'preserve',
      module: 'preserve',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      plugins: [{name: PLUGIN, framework: 'svelte'}],
    };
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions, include: ['*.ucf', '*.ts']}));
    card = {filename: join(dir, 'Card.ucf'), source: CARD.source};
    await copyFile(CARD.filename, card.filename);
    importer = {filename: join(dir, 'default.ts'), source: "import Card from './Card.ucf';\n\nexport {Card};\n"};
    await writeFile(importer.filename, importer.source);
    // Set as pnpm's bin shim does: the tsserver must not inherit it.
    const nodePath = process.env.NODE_PATH;
    process.env.NODE_PATH = join(E2E_DIR, '..', '..', 'node_modules', '.pnpm', 'node_modules');
    try {
      server = startTsserver({cwd: dir, plugins: [PLUGIN]});
    } finally {
      if (nodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = nodePath;
    }
    await open(server, [card, importer]);
  });

  afterAll(async () => {
    await server?.stop();
    if (dir) await rm(dir, {recursive: true, force: true});
  });

  it('still serves the <react> block, with $style typed loosely', async () => {
    const codes = (await server.diagnostics(card.filename)).map(({code}) => code);
    expect(codes).not.toContain(2304); // "Cannot find name '$style'": the raw file read as TSX
    expect(codes).not.toContain(2339);
    const info = await server.request<TsQuickInfo>('quickinfo', {file: card.filename, ...locate(card.source, '<h2>{title}', 5)});
    expect(info.displayString).toContain('title: string');
  });

  it('completion after $style. has no card: the scss module is not read', async () => {
    const at = locate(card.source, STYLE_ACCESS, STYLE_ACCESS.length);
    const completions = await server.request<Completions>('completionInfo', {file: card.filename, ...at});
    expect(completions.entries.map(({name}) => name)).not.toContain('card');
  });

  it('a bare import picked by the default framework names that rule', async () => {
    const diagnostics = await server.diagnostics(importer.filename);
    expect(diagnostics).toMatchObject([{code: 'target-not-built', start: locate(importer.source, "'./Card.ucf'")}]);
    expect(diagnostics[0]!.text).toBe(
      './Card.ucf is imported as svelte (by the default framework); multifront has no svelte types yet'
    );
  });
});
