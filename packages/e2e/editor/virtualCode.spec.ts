import {BLOCK_KINDS, splitBlocks} from '@multifront/core';
import type {Block} from '@multifront/core';
import {createUcfLanguagePlugin, EDITOR_BLOCK_KINDS} from '@multifront/language-tools';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {listComponents, readComponent} from '../fixtures/index.ts';

const plugin = createUcfLanguagePlugin();
// Volar's types, through the plugin: e2e does not depend on Volar itself.
type VirtualCode = NonNullable<ReturnType<NonNullable<typeof plugin.createVirtualCode>>>;
type CodeMapping = VirtualCode['mappings'][number];
const NAMES = [...listComponents(), ...listComponents('invalid'), ...listComponents('langs')];
const LANGUAGE_IDS: Record<string, string> = {css: 'css', scss: 'scss', react: 'typescriptreact'};
const EXTS: Record<string, string> = {css: '.css', scss: '.scss', typescriptreact: '.tsx'};
const ALL_ON = {verification: true, completion: true, semantic: true, navigation: true, structure: true, format: true};

function textOf(code: VirtualCode): string {
  return code.snapshot.getText(0, code.snapshot.getLength());
}

function createRoot(name: string) {
  const {filename, source} = readComponent(name);
  const snapshot = ts.ScriptSnapshot.fromString(source);
  const root = plugin.createVirtualCode!(filename, plugin.getLanguageId(filename)!, snapshot, {
    getAssociatedScript: () => undefined,
  })!;
  return {filename, source, split: splitBlocks(source, filename), root, embedded: root.embeddedCodes ?? []};
}

// The codes the kept blocks must give: every css / scss style, then the first <react>.
function expectedCodes(styles: Block[], react: Block | undefined): {id: string; languageId: string; block: Block}[] {
  const codes = styles.flatMap((block) => {
    const lang = block.attrs.lang ?? 'css';
    return lang === 'css' || lang === 'scss' ? [{id: `style_${block.index}`, languageId: lang, block}] : [];
  });
  return react ? [...codes, {id: 'react', languageId: LANGUAGE_IDS.react!, block: react}] : codes;
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
    expect(plugin.getLanguageId('/abs/Card.ucf')).toBe('ucf');
    expect(plugin.getLanguageId('/abs/App.tsx')).toBeUndefined();
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {extension: 'ucf', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred},
    ]);
  });

  describe.each(NAMES)('%s', (name) => {
    const {source, split, root, embedded} = createRoot(name);

    it('has a ucf root code over the whole source', () => {
      expect(root.id).toBe('root');
      expect(root.languageId).toBe('ucf');
      expect(textOf(root)).toBe(source);
    });

    it('gives one code per block the splitter kept, with its language', () => {
      const expected = expectedCodes(split.styles, split.targets.react);
      expect(embedded.map(({id, languageId}) => ({id, languageId}))).toEqual(
        expected.map(({id, languageId}) => ({id, languageId}))
      );
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

    it('maps the whole block content with every feature on', () => {
      for (const {id, block} of expectedCodes(split.styles, split.targets.react)) {
        const code = embedded.find((candidate) => candidate.id === id)!;
        const covered = new Set<number>();
        for (const mapping of code.mappings) {
          expect(mapping.data).toEqual(ALL_ON);
          for (const {
            source: [start, end],
          } of segments(mapping))
            for (let offset = start; offset < end; offset++) covered.add(offset);
        }
        for (let offset = block.contentStart; offset < block.contentEnd; offset++)
          expect(covered.has(offset), `${id} at ${offset}`).toBe(true);
      }
    });

    it('serves the react code as the file’s own TypeScript script', () => {
      const react = embedded.find(({id}) => id === 'react');
      const expected = react && {code: react, extension: '.tsx', scriptKind: ts.ScriptKind.TSX};
      expect(plugin.typescript!.getServiceScript(root)).toEqual(expected);
    });

    it('matches the code snapshots', async () => {
      for (const code of embedded) {
        await expect(textOf(code)).toMatchFileSnapshot(`__snapshots__/virtualCode/${name}.${code.id}${EXTS[code.languageId]}`);
      }
    });
  });
});
