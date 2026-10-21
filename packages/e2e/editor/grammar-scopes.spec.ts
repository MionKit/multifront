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

// Vue grammar's scope for a target block's content, keyed by its `lang`.
const VUE_GRAMMAR_SCOPES: Record<string, string> = {tsx: 'source.tsx', vue: 'text.html.vue', html: 'text.html.derivative'};

// GitHub and Shiki color a `.ucf` file with Vue's grammar.
function asVue(name: string): {block: Block | undefined; text: string; scopes: string[]}[] {
  const {filename, source} = readComponent(name);
  const {blocks} = splitBlocks(source, filename);
  const grammar = highlighter.getLanguage('vue');
  const tokens = [];
  let state = null;
  let lineStart = 0;
  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const token of result.tokens) {
      const start = lineStart + token.startIndex;
      const block = blocks.find(({contentStart, contentEnd}) => contentStart <= start && start < contentEnd);
      tokens.push({block, text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes.slice(1)});
    }
    lineStart += line.length + 1;
  }
  return tokens.filter(({text}) => text.trim() !== '');
}

function vueScopeOf(block: Block): string {
  return block.type === 'style' ? pickGrammar(block).scopeName : VUE_GRAMMAR_SCOPES[String(block.attrs.lang)]!;
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

describe('a .ucf file read as Vue by the real Vue grammar, as GitHub and Shiki read it', () => {
  it('names a Vue grammar scope for the lang of every target kind', () => {
    for (const kind of BLOCK_KINDS.filter(({role}) => role === 'target')) expect(VUE_GRAMMAR_SCOPES).toHaveProperty(kind.lang!);
  });

  it.each(listComponents())('%s: each block is colored by the language its lang names, and TSX stays in <react>', (name) => {
    const tokens = asVue(name);
    const types = new Set(tokens.flatMap(({block}) => block?.type ?? []));
    expect(types.size).toBeGreaterThan(0);
    const wrong = tokens.filter(({block, scopes}) => (block ? !scopes.includes(vueScopeOf(block)) : false));
    expect(wrong).toEqual([]);
    const leaked = tokens.filter(({block, scopes}) => block?.type !== 'react' && scopes.includes('source.tsx'));
    // Only the closing tag: Vue's grammar ends a `lang="tsx"` block at the end of the file.
    expect(leaked.map(({text}) => text).join('')).toBe(types.has('react') ? '</react>' : '');
  });

  it('Card.ucf: all four blocks, nested Vue code in <vue>', () => {
    const tokens = asVue('Card.ucf');
    expect(new Set(tokens.flatMap(({block}) => block?.type ?? []))).toEqual(new Set(['vue', 'svelte', 'style', 'react']));
    expect(tokens.find(({text}) => text === 'defineProps')?.scopes).toContain('source.ts');
  });

  it('invalid/BlockLang.ucf: a <vue> with no lang stays plain text', () => {
    const vue = asVue('invalid/BlockLang.ucf').filter(({block}) => block?.type === 'vue');
    expect(vue.length).toBeGreaterThan(0);
    expect(vue.filter(({scopes}) => scopes.length > 1 && scopes[0] !== 'text')).toEqual([]);
  });

  // Why react-not-last exists.
  it('invalid/ReactNotLast.ucf: the <style> after <react lang="tsx"> is colored as TSX', () => {
    const style = asVue('invalid/ReactNotLast.ucf').filter(({block}) => block?.type === 'style');
    expect(style.length).toBeGreaterThan(0);
    expect(style.every(({scopes}) => scopes.includes('source.tsx') && !scopes.includes('source.css'))).toBe(true);
  });
});
