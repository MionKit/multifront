import type {BlockKind, BlockTag, Diagnostic, SplitResult} from '../types.ts';
import {reactKind} from './react.ts';
import {styleKind} from './style.ts';
import {svelteKind} from './svelte.ts';
import {vueKind} from './vue.ts';

// Key order = registry order: shared kinds first, then targets in `TARGETS` order.
const KINDS_BY_TAG: Record<BlockTag, BlockKind> = {style: styleKind, vue: vueKind, react: reactKind, svelte: svelteKind};

export const BLOCK_KINDS: readonly BlockKind[] = Object.values(KINDS_BY_TAG);

export function getBlockKind(tag: BlockTag): BlockKind {
  return KINDS_BY_TAG[tag];
}

/** Splitter errors plus every block's own rules, in `start` order. Hosts call this, never the kinds one by one. */
export function checkBlocks(split: SplitResult): Diagnostic[] {
  const blockErrors = split.blocks.flatMap((block) => getBlockKind(block.type).check(block, split));
  return [...split.errors, ...blockErrors].sort((first, second) => first.start - second.start);
}
