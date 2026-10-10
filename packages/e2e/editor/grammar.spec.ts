import {BLOCK_KINDS, getBlockKind, splitBlocks} from '@multifront/core';
import type {Block, BlockTag, SplitResult} from '@multifront/core';
import {generateGrammar} from 'multifront-vscode/grammar';
import {describe, expect, it} from 'vitest';
import {componentPath, listComponents, readComponent} from '../fixtures/index.ts';
import {hasScope, tokenizeUcf} from './lib/tokenize.ts';
import type {ScopedToken} from './lib/tokenize.ts';

const grammars = generateGrammar();

const BLOCK_SCOPE = new RegExp(`^meta\\.embedded\\.block\\.(${BLOCK_KINDS.map(({tag}) => tag).join('|')})(\\.|$)`);

type Tokenized = Pick<SplitResult, 'source' | 'blocks'> & {tokens: ScopedToken[]};

async function tokenize(name: string): Promise<Tokenized> {
  const {filename, source} = readComponent(name);
  return {source, blocks: splitBlocks(source, filename).blocks, tokens: await tokenizeUcf(componentPath(name), grammars)};
}

function tokenAt({tokens}: Tokenized, offset: number): ScopedToken {
  const token = tokens.find((candidate) => candidate.start <= offset && offset < candidate.end);
  if (!token) throw new Error(`no token at ${offset}`);
  return token;
}

// `skip` moves past a prefix of the needle.
function tokenIn(file: Tokenized, tag: BlockTag, needle: string, skip = 0): ScopedToken {
  const block = file.blocks.find((candidate) => candidate.type === tag)!;
  const at = file.source.indexOf(needle, block.contentStart);
  expect(at, `${needle} in <${tag}>`).toBeGreaterThanOrEqual(block.contentStart);
  expect(at).toBeLessThan(block.contentEnd);
  return tokenAt(file, at + skip);
}

// The content scope the block's own grammar rule must give: `lang` picks a `byLang` grammar, as in the build.
function contentScope(block: Block): string {
  const {lang} = block.attrs;
  const byLang = getBlockKind(block.type).grammar.byLang ?? {};
  const scope = typeof lang === 'string' && Object.hasOwn(byLang, lang) ? byLang[lang] : undefined;
  return `meta.embedded.block.${block.type}${scope ? `.${scope.languageId}` : ''}`;
}

function where(source: string, offset: number): string {
  const line = source.slice(0, offset).split('\n').length;
  return `${line}:${offset - source.lastIndexOf('\n', offset - 1) - 1} ${JSON.stringify(source[offset])}`;
}

// Every character whose block content scope differs from the one its splitter block wants.
function mismatches({source, blocks, tokens}: Tokenized): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    const got = [...new Set(token.scopes.filter((scope) => BLOCK_SCOPE.test(scope)))].join();
    for (let offset = token.start; offset < token.end; offset++) {
      const block = blocks.find(({contentStart, contentEnd}) => contentStart <= offset && offset < contentEnd);
      const want = block ? contentScope(block) : '';
      if (got !== want) found.push(`${where(source, offset)} wants [${want}] got [${got}]`);
    }
  }
  return found;
}

// Vue and Svelte scopes outside their own block: an injection that escaped its block.
function leaks({source, blocks, tokens}: Tokenized): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    const block = blocks.find(({contentStart, contentEnd}) => contentStart <= token.start && token.start < contentEnd);
    const foreign = token.scopes.filter((scope) => /\.(vue|svelte)$/.test(scope) && !scope.endsWith(`.${block?.type}`));
    if (foreign.length) found.push(`${where(source, token.start)} in <${block?.type ?? 'none'}> has ${foreign.join(' ')}`);
  }
  return found;
}

describe('the .ucf grammar generated from the block registry, in the real vscode-textmate', () => {
  it('serves every grammar under its own scope and never includes an upstream one', () => {
    expect(grammars[0]!.scopeName).toBe('source.ucf');
    expect(grammars.filter(({scopeName}) => !scopeName.startsWith('source.ucf'))).toEqual([]);
    // The test registry also holds shiki's text.html.vue and source.svelte, so a missed rename would still highlight.
    expect(JSON.stringify(grammars)).not.toMatch(/"include":"(text\.html\.vue|source\.svelte|vue\.)/);
  });

  it.each([
    ...listComponents(),
    ...listComponents('langs'),
    ...listComponents('editor'),
    'invalid/BrokenOpeningTags.ucf', // `<style scoped/>` opens nothing
    'invalid/UnknownRootTag.ucf', // `<react_old>` is not `<react>`
  ])('%s: each block scope covers exactly the content splitBlocks reads, and no injection escapes', async (name) => {
    const file = await tokenize(name);
    expect(file.blocks.length).toBeGreaterThan(0);
    expect(mismatches(file)).toEqual([]);
    expect(leaks(file)).toEqual([]);
  });

  it('Card.ucf: every block gets its own language scopes', async () => {
    const card = await tokenize('Card.ucf');
    expect(tokenIn(card, 'react', 'export').scopes).toContain('keyword.control.export.tsx');
    // The vue.directives and vue.interpolations injections, served under source.ucf.vue.
    expect(tokenIn(card, 'vue', ':class').scopes).toContain('punctuation.attribute-shorthand.bind.html.vue');
    expect(tokenIn(card, 'vue', ':class', 1).scopes).toContain('entity.other.attribute-name.html.vue');
    expect(tokenIn(card, 'vue', '{{').scopes).toContain('punctuation.definition.interpolation.begin.html.vue');
    expect(tokenIn(card, 'svelte', '{title}').scopes).toContain('punctuation.section.embedded.begin.svelte');
    expect(tokenIn(card, 'svelte', '{title}', 1).scopes).toContain('meta.embedded.expression.svelte');
    // Svelte embeds its <script> through its own injections, lifted to the root grammar.
    expect(tokenIn(card, 'svelte', 'let').scopes).toContain('source.ts');
    expect(tokenAt(card, card.source.indexOf('<react>') + 1).scopes).toContain('entity.name.tag.ucf');
  });

  it('Panel.ucf: the <style lang = scss> block uses the SCSS grammar', async () => {
    const panel = await tokenize('Panel.ucf');
    expect(tokenIn(panel, 'style', '$pad').scopes).toContain('variable.scss');
  });

  it('editor/GrammarEdges.ucf: injections that name the Vue root, and Svelte rules reached through #scope', async () => {
    const edges = await tokenize('editor/GrammarEdges.ucf');
    // vue.sfc.script.leading-operator-fix: its selector names text.html.vue.
    expect(tokenIn(edges, 'vue', '< limit').scopes).toContain('keyword.operator.relational.js');
    // Svelte's <template> injection includes its own #scope.
    expect(tokenIn(edges, 'svelte', '{limit}').scopes).toEqual(
      expect.arrayContaining(['meta.template.svelte', 'punctuation.section.embedded.begin.svelte'])
    );
    expect(tokenIn(edges, 'style', '$gap').scopes).toContain('variable.scss');
  });

  it('TsxEdges.ucf: <>, <T,> and a < b end the <react> scope exactly at </react>', async () => {
    const edges = await tokenize('TsxEdges.ucf');
    const react = edges.blocks.find(({type}) => type === 'react')!;
    expect(tokenAt(edges, react.contentEnd).scopes.filter((scope) => scope.startsWith('meta.embedded'))).toEqual([]);
    const lastBrace = edges.source.lastIndexOf('}', react.contentEnd);
    expect(hasScope(tokenAt(edges, lastBrace), 'meta.embedded.block.react')).toBe(true);
  });

  // The documented limit: inside a string the TSX grammar never sees `</react>`, the splitter does.
  it('invalid/ReactCloseInString.ucf: the react scope runs past the closing tag the splitter takes', async () => {
    const file = await tokenize('invalid/ReactCloseInString.ucf');
    const react = file.blocks.find(({type}) => type === 'react')!;
    expect(hasScope(tokenAt(file, react.contentEnd), 'meta.embedded.block.react')).toBe(true);
    expect(mismatches(file)).not.toEqual([]);
  });
});
