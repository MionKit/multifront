import {getBlockKind} from './blocks/index.ts';
import type {Diagnostic, SplitResult} from './types.ts';

/** Splitter errors plus every block's own rules, in `start` order. Hosts call this, never the kinds one by one. */
export function checkBlocks(split: SplitResult): Diagnostic[] {
  const blockErrors = split.blocks.flatMap((block) => getBlockKind(block.type).check(block, split));
  return [...split.errors, ...blockErrors].sort((first, second) => first.start - second.start);
}
