import {createDiagnostic} from '../diagnostics.ts';
import {topLevelTags} from '../scan.ts';
import type {Block, BlockKind, Diagnostic, SplitResult} from '../types.ts';

// A `<style>` inside the SFC `<template>` is markup, not an SFC style block.
function check(block: Block, split: SplitResult): Diagnostic[] {
  const message = '<style> cannot sit inside the <vue> block; move it to the root of the file';
  return topLevelTags(block.content, (name) => name === 'template')
    .filter((tag) => tag.name === 'style')
    .map((tag) =>
      createDiagnostic(split, 'style-inside-target', block.contentStart + tag.start, block.contentStart + tag.end, message)
    );
}

export const vueKind: BlockKind = {tag: 'vue', role: 'target', check};
