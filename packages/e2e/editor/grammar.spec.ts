import {BLOCK_KINDS, splitBlocks} from '@multifront/core';
import type {Block, BlockTag} from '@multifront/core';
import {generateGrammar} from 'multifront-vscode/grammar';
import {beforeAll, describe, expect, it} from 'vitest';
import {componentPath, listComponents, readComponent} from '../fixtures/index.ts';
import {hasScope, tokenizeUcf} from './lib/tokenize.ts';
import type {ScopedToken} from './lib/tokenize.ts';

const grammars = generateGrammar();

interface Tokenized {
  source: string;
  blocks: Block[];
  tokens: ScopedToken[];
}

const cache = new Map<string, Tokenized>();

async function tokenize(name: string): Promise<Tokenized> {
  const cached = cache.get(name);
  if (cached) return cached;
  const {filename, source} = readComponent(name);
  const tokenized = {
    source,
    blocks: splitBlocks(source, filename).blocks,
    tokens: await tokenizeUcf(componentPath(name), grammars),
  };
  cache.set(name, tokenized);
  return tokenized;
}

function tokenAt({tokens}: Tokenized, offset: number): ScopedToken {
  const token = tokens.find((candidate) => candidate.start <= offset && offset < candidate.end);
  if (!token) throw new Error(`no token at ${offset}`);
  return token;
}

// The token of the first `needle` inside the `tag` block; `skip` moves `at` past a prefix of the needle.
function tokenIn(file: Tokenized, tag: BlockTag, needle: string, skip = 0): ScopedToken {
  const block = file.blocks.find((candidate) => candidate.type === tag)!;
  const at = file.source.indexOf(needle, block.contentStart);
  expect(at, `${needle} in <${tag}>`).toBeGreaterThanOrEqual(block.contentStart);
  expect(at).toBeLessThan(block.contentEnd);
  return tokenAt(file, at + skip);
}

// Every character whose embedded block scope differs from the splitter's block.
function mismatches({source, blocks, tokens}: Tokenized): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    const got = BLOCK_KINDS.filter(({tag}) => hasScope(token, `meta.embedded.block.${tag}`)).map(({tag}) => tag);
    for (let offset = token.start; offset < token.end; offset++) {
      const block = blocks.find(({contentStart, contentEnd}) => contentStart <= offset && offset < contentEnd);
      const want = block ? [block.type] : [];
      if (got.join() === want.join()) continue;
      const line = source.slice(0, offset).split('\n').length;
      const column = offset - source.lastIndexOf('\n', offset - 1) - 1;
      found.push(`${line}:${column} ${JSON.stringify(source[offset])} wants [${want.join()}] got [${got.join()}]`);
    }
  }
  return found;
}

beforeAll(async () => {
  await tokenize('Card.ucf'); // loads the WASM and the built-in grammars once
}, 60_000);

describe('the .ucf grammar generated from the block registry, in the real vscode-textmate', () => {
  it('serves every grammar under its own scope, so none clashes with the Vue or Svelte extension', () => {
    expect(grammars[0]!.scopeName).toBe('source.ucf');
    expect(grammars.filter(({scopeName}) => !/^(source\.ucf|ucf\.)/.test(scopeName))).toEqual([]);
  });

  it.each([...listComponents(), ...listComponents('langs')])(
    '%s: each block scope covers exactly the content splitBlocks reads',
    async (name) => {
      const file = await tokenize(name);
      expect(file.blocks.length).toBeGreaterThan(0);
      expect(mismatches(file)).toEqual([]);
    }
  );

  it('Card.ucf: every block gets its own language scopes', async () => {
    const card = await tokenize('Card.ucf');
    expect(tokenIn(card, 'react', 'export').scopes).toContain('keyword.control.export.tsx');
    // The vue.directives and vue.interpolations injections, served as ucf.vue.*.
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
