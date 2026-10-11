import {BLOCK_KINDS, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {Block} from '@multifront/core';
import {createUcfLanguagePlugin, EDITOR_BLOCK_KINDS, getTypesScript} from '@multifront/language-tools';
import {createLanguage} from '@volar/language-core';
import type {CodeMapping, VirtualCode} from '@volar/language-core';
import ts from 'typescript';
import {readdirSync, readFileSync} from 'node:fs';
import {join, sep} from 'node:path';
import {describe, expect, it} from 'vitest';
import {componentPath, FIXTURES_DIR, listComponents, readComponent} from '../fixtures/index.ts';

const compiler = loadVueCompiler(FIXTURES_DIR);
const plugin = createUcfLanguagePlugin({compiler});
// Volar's own registry: it picks the language, creates the codes, keeps them by id.
const language = createLanguage([plugin], new Map(), () => {});
const NAMES = [...listComponents(), ...listComponents('invalid'), ...listComponents('langs'), ...listComponents('editor')];
const EXTS: Record<string, string> = {css: '.css', scss: '.scss', typescriptreact: '.tsx'};
const ALL_ON = {verification: true, completion: true, semantic: true, navigation: true, structure: true, format: true};

function textOf(code: VirtualCode): string {
  return code.snapshot.getText(0, code.snapshot.getLength());
}

function load(name: string) {
  const {filename, source} = readComponent(name);
  const script = language.scripts.set(filename, ts.ScriptSnapshot.fromString(source))!;
  const {root, embeddedCodes} = script.generated!;
  const split = splitBlocks(source, filename);
  return {filename, script, source, split, root, byId: embeddedCodes, embedded: root.embeddedCodes ?? []};
}

// Expected codes: css / scss styles, then the first <react>.
function expectedCodes(styles: Block[], react: Block | undefined): {id: string; languageId: string; block: Block}[] {
  const codes = styles.flatMap((block) => {
    const lang = block.attrs.lang ?? 'css';
    return lang === 'css' || lang === 'scss' ? [{id: `style_${block.index}`, languageId: lang, block}] : [];
  });
  return react ? [...codes, {id: 'react', languageId: 'typescriptreact', block: react}] : codes;
}

function segments(mapping: CodeMapping): {source: [number, number]; generated: [number, number]}[] {
  return mapping.sourceOffsets.map((start, i) => {
    const length = mapping.lengths[i]!;
    const generatedStart = mapping.generatedOffsets[i]!;
    return {
      source: [start, start + length],
      generated: [generatedStart, generatedStart + (mapping.generatedLengths?.[i] ?? length)],
    };
  });
}

describe('createUcfLanguagePlugin turns a .ucf file into mapped TSX and CSS / SCSS codes', () => {
  it('lists the same tags as the core registry, in the same order', () => {
    expect(EDITOR_BLOCK_KINDS.map(({tag}) => tag)).toEqual(BLOCK_KINDS.map(({tag}) => tag));
  });

  it('claims .ucf files only, and tells TypeScript about the extension', () => {
    const tsFile = join(FIXTURES_DIR, 'apps', 'vue-reference', 'src', 'main.ts');
    expect(plugin.getLanguageId(componentPath('Card.ucf'))).toBe('ucf');
    expect(plugin.getLanguageId(tsFile)).toBeUndefined();
    const tsScript = language.scripts.set(tsFile, ts.ScriptSnapshot.fromString(readFileSync(tsFile, 'utf8')), 'typescript');
    expect(tsScript?.generated).toBeUndefined();
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {extension: 'ucf', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred},
    ]);
  });

  it('reads plain CSS modules with no options, and types the others loosely', () => {
    const bare = createLanguage([createUcfLanguagePlugin()], new Map(), () => {});
    const reactText = (name: string) => {
      const {filename, source} = readComponent(name);
      const script = bare.scripts.set(filename, ts.ScriptSnapshot.fromString(source))!;
      return textOf(script.generated!.embeddedCodes.get('react')!);
    };
    expect(reactText('Button.ucf')).toContain('declare const classes: {readonly primary: string};');
    expect(reactText('Card.ucf')).toContain('declare const $style: {readonly [name: string]: string};');
  });

  describe.each(NAMES)('%s', (name) => {
    const {filename, script, source, split, root, byId, embedded} = load(name);

    it('has a ucf root code over the whole source', () => {
      expect(script.languageId).toBe('ucf');
      expect(root.id).toBe('root');
      expect(root.languageId).toBe('ucf');
      expect(textOf(root)).toBe(source);
      expect(root.mappings).toEqual([{sourceOffsets: [0], generatedOffsets: [0], lengths: [source.length], data: ALL_ON}]);
    });

    it('gives one code per block the splitter kept, with its language', () => {
      const expected = expectedCodes(split.styles, split.targets.react);
      expect(embedded.map(({id, languageId}) => ({id, languageId}))).toEqual(
        expected.map(({id, languageId}) => ({id, languageId}))
      );
      expect([...byId.keys()]).toEqual(['root', ...expected.map(({id}) => id)]);
    });

    it('maps every segment exactly: the source slice equals the generated slice', () => {
      for (const code of [root, ...embedded]) {
        const text = textOf(code);
        for (const mapping of code.mappings) {
          for (const {
            source: [start, end],
            generated: [generatedStart, generatedEnd],
          } of segments(mapping)) {
            expect(text.slice(generatedStart, generatedEnd), `${code.id} at ${start}`).toBe(source.slice(start, end));
          }
        }
      }
    });

    it('maps the whole block content with every feature on, through Volar’s mapper', () => {
      for (const {id, block} of expectedCodes(split.styles, split.targets.react)) {
        const code = byId.get(id)!;
        const text = textOf(code);
        const mapper = language.maps.get(code, script);
        const [content, ...classKeys] = code.mappings;
        expect(content).toEqual({
          sourceOffsets: [block.contentStart],
          generatedOffsets: [0],
          lengths: [block.content.length],
          data: ALL_ON,
        });
        // React's CSS module keys, jumping to their class names.
        for (const mapping of classKeys) expect(mapping.data).toEqual({navigation: true});
        if (id !== 'react') expect(classKeys).toEqual([]);
        for (let offset = block.contentStart; offset < block.contentEnd; offset++) {
          const [generated] = mapper.toGeneratedLocation(offset).next().value ?? [];
          expect(generated === undefined ? undefined : text[generated], `${id} at ${offset}`).toBe(source[offset]);
        }
      }
    });

    it('serves the react code as the file’s own TypeScript script, an empty module without one', () => {
      const react = embedded.find(({id}) => id === 'react');
      const script = plugin.typescript!.getServiceScript(root)!;
      expect(script).toMatchObject({extension: '.tsx', scriptKind: ts.ScriptKind.TSX});
      if (react) expect(script.code).toBe(react);
      else expect([textOf(script.code), script.code.mappings]).toEqual(['export {};\n', []]);
    });

    // M5 emits `.d.ts` files with getTypesScript: they must be what the editor shows.
    it('getTypesScript gives the react code and its mappings', () => {
      const react = byId.get('react');
      const types = getTypesScript(filename, source, 'react', {compiler});
      expect(types && {code: types.code, mappings: types.mappings}).toEqual(
        react && {code: textOf(react), mappings: react.mappings}
      );
    });

    it('matches the code snapshots', async () => {
      for (const code of embedded) {
        await expect(textOf(code)).toMatchFileSnapshot(`__snapshots__/virtualCode/${name}.${code.id}${EXTS[code.languageId]}`);
      }
    });
  });
});

// Every real fixture, broken ones included: the <vue> code is what Vue's parser and tsserver read.
const VUE_NAMES = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
  .filter((name) => name.endsWith('.ucf'))
  .map((name) => name.split(sep).join('/'))
  .filter((name) => readComponent(name).source.includes('<vue'))
  .sort();

describe('with TypeScript, a <vue> block becomes a nested VueVirtualCode', () => {
  const vuePlugin = createUcfLanguagePlugin({compiler, ts});
  const vueLanguage = createLanguage([vuePlugin], new Map(), () => {});
  const vueKind = EDITOR_BLOCK_KINDS.find(({tag}) => tag === 'vue')!;

  it('makes the vue and react rows full rows of the grid', () => {
    for (const tag of ['vue', 'react'] as const) {
      const core = BLOCK_KINDS.find((kind) => kind.tag === tag)!;
      const editor = EDITOR_BLOCK_KINDS.find((kind) => kind.tag === tag)!;
      expect([core.check, core.build, core.grammar, editor.editor, editor.types].every(Boolean), tag).toBe(true);
    }
  });

  it('covers the fixtures with a <vue> block', () => {
    expect(VUE_NAMES).toEqual(expect.arrayContaining(['Counter.ucf', 'vue/CounterCrlf.ucf', 'vue/VueWithUnclosedReact.ucf']));
  });

  describe.each(VUE_NAMES)('%s', (name) => {
    const {filename, source} = readComponent(name);
    const script = vueLanguage.scripts.set(filename, ts.ScriptSnapshot.fromString(source))!;
    const split = splitBlocks(source, filename);
    const vue = split.targets.vue;
    const code = script.generated!.embeddedCodes.get('vue');
    const ids = (codes: VirtualCode[] = []): string[] => codes.flatMap(({id, embeddedCodes}) => [id, ...ids(embeddedCodes)]);

    it('has a vue code exactly when the splitter kept the block', () => {
      expect(code?.languageId).toBe(vue ? 'vue' : undefined);
    });

    it.runIf(vue)('keeps only our style codes: Vue’s own are left out', () => {
      expect(ids(code!.embeddedCodes).filter((id) => /^style_\d+$/.test(id))).toEqual([]);
      const ours = [...script.generated!.embeddedCodes.keys()].filter((id) => /^style_\d+$/.test(id));
      expect(ours).toEqual(expectedCodes(split.styles, undefined).map(({id}) => id));
    });

    it.runIf(vue)('is the source, same length and line breaks, blank outside the <vue> content and root <style>s', () => {
      const text = textOf(code!);
      expect(text.length).toBe(source.length);
      const kept = [vue!, ...split.styles].map((block) =>
        block === vue ? [block.contentStart, block.contentEnd] : [block.start, block.end]
      );
      for (let offset = 0; offset < source.length; offset++) {
        const inside = kept.some(([start, end]) => offset >= start! && offset < end!);
        const char = source[offset]!;
        const expected = inside || char === '\r' || char === '\n' ? char : ' ';
        if (text[offset] !== expected) expect(text[offset], `offset ${offset}`).toBe(expected);
      }
    });

    it.runIf(vue)('serves its script code to tsserver, the same file getTypesScript gives importers', () => {
      const served = vueKind.serviceScript!(code!)!;
      // As in a `.vue` file: a `<script>` with no lang is JavaScript, no `<script>` at all TypeScript.
      const lang = vue!.content.includes('<script') ? (/<script[^>]*\blang="(\w+)"/.exec(vue!.content)?.[1] ?? 'js') : 'ts';
      expect(served.code.id).toBe(`script_${lang}`);
      expect(served.scriptKind).toBe({js: ts.ScriptKind.JS, ts: ts.ScriptKind.TS}[lang]);
      const types = getTypesScript(filename, source, 'vue', {compiler, ts})!;
      // Feature flags hold closures, new per run: compare the mappings as data.
      const data = (mappings: CodeMapping[]) => JSON.parse(JSON.stringify(mappings)) as unknown;
      expect({code: types.code, mappings: data(types.mappings), ext: types.ext}).toEqual({
        code: textOf(served.code),
        mappings: data(served.code.mappings),
        ext: '.ts',
      });
    });
  });

  it('gives no vue code and no types without TypeScript', () => {
    const {filename, source} = readComponent('Counter.ucf');
    expect(load('Counter.ucf').byId.has('vue')).toBe(false);
    expect(getTypesScript(filename, source, 'vue', {compiler})).toBeUndefined();
  });
});
