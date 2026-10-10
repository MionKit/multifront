import {BLOCK_KINDS, getBlockKind, splitBlocks, type Block, type GrammarScope} from '@multifront/core';
import {bundledLanguages, createHighlighter, type Highlighter, type LanguageRegistration} from 'shiki';
import {beforeAll, describe, expect, it} from 'vitest';
import {listComponents, readComponent} from '../fixtures/index.ts';

const REGISTRY_SCOPES = [
  ...new Set(
    BLOCK_KINDS.flatMap((kind) => [kind.grammar, ...Object.values(kind.grammar.byLang ?? {})]).map((scope) => scope.scopeName)
  ),
];

let grammarsByScope: Map<string, LanguageRegistration>;
let highlighter: Highlighter;

beforeAll(async () => {
  const modules = await Promise.all(Object.values(bundledLanguages).map((load) => load()));
  grammarsByScope = new Map(modules.flatMap((module) => module.default).map((grammar) => [grammar.scopeName, grammar]));
  const langs = REGISTRY_SCOPES.flatMap((scopeName) => grammarsByScope.get(scopeName)?.name ?? []);
  highlighter = await createHighlighter({themes: [], langs});
  return () => highlighter.dispose();
});

function pickGrammar(block: Block): GrammarScope {
  const {grammar} = getBlockKind(block.type);
  const {lang} = block.attrs;
  return typeof lang === 'string' && grammar.byLang && Object.hasOwn(grammar.byLang, lang) ? grammar.byLang[lang]! : grammar;
}

function rootOnlyText(content: string, scopeName: string): string[] {
  const grammar = highlighter.getLanguage(grammarsByScope.get(scopeName)!.name);
  const rootOnly: string[] = [];
  let state = null;
  for (const line of content.split(/\r?\n/)) {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (token.scopes.length === 1 && text.trim() !== '') rootOnly.push(text);
    }
  }
  return rootOnly;
}

function blocksOf(name: string): Block[] {
  const {filename, source} = readComponent(name);
  return splitBlocks(source, filename).blocks;
}

describe('grammar data of the block kinds, against the real shiki grammars', () => {
  it('names a real grammar for every scope in the registry', () => {
    expect(REGISTRY_SCOPES.filter((scopeName) => !grammarsByScope.has(scopeName))).toEqual([]);
  });

  it.each(listComponents())('%s: every block tokenizes with the grammar its kind and lang pick', (name) => {
    const blocks = blocksOf(name);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const {scopeName} = pickGrammar(block);
      expect({block: block.start, rootOnly: rootOnlyText(block.content, scopeName)}).toEqual({block: block.start, rootOnly: []});
    }
  });

  // Proves the root-only check can fail: the CSS grammar cannot read SCSS.
  it('catches a wrong pick: the SCSS block of Panel.ucf through source.css leaves plain text', () => {
    const scss = blocksOf('Panel.ucf').find((block) => block.attrs.lang === 'scss')!;
    expect(pickGrammar(scss).scopeName).toBe('source.css.scss');
    expect(rootOnlyText(scss.content, 'source.css')).not.toEqual([]);
  });
});
