import MagicString from 'magic-string';
import {styleInsideTarget} from '../diagnostics.ts';
import {isTarget} from '../targets.ts';
import type {Block, BlockKind, SourceMap} from '../types.ts';

// Like Vue's SFC parser: every root tag but `<template>` is raw text; a `<style>` inside `<template>` is markup.
export const vueKind: BlockKind = {
  tag: 'vue',
  role: 'target',
  grammar: {scopeName: 'text.html.vue', languageId: 'vue'}, // the official Vue extension's scope name
  check: (block, split) =>
    styleInsideTarget(
      block,
      split,
      (name) => name === 'template',
      (name) => name !== 'template'
    ),
};

// Line breaks stay original characters, so lines and columns (CRLF included) match the .ucf file.
function blank(text: MagicString, source: string, start: number, end: number): void {
  for (const run of source.slice(start, end).matchAll(/[^\r\n]+/g)) {
    const runStart = start + run.index;
    text.overwrite(runStart, runStart + run[0].length, ' '.repeat(run[0].length));
  }
}

/** SFC code as long as the `.ucf` source: `<vue>` content and root `<style>` blocks kept, other targets blanked. */
export function vueSfcCode(source: string, blocks: Block[], filename: string): {code: string; map: SourceMap} {
  const text = new MagicString(source);
  const vue = blocks.find((block) => block.type === 'vue');
  for (const block of blocks) {
    if (block === vue) {
      blank(text, source, block.start, block.contentStart);
      blank(text, source, block.contentEnd, block.end);
    } else if (isTarget(block.type)) blank(text, source, block.start, block.end);
  }
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: filename, hires: true, includeContent: true});
  return {code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}
