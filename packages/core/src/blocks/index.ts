import type {BlockKind, BlockTag} from '../types.ts';
import {reactKind} from './react.ts';
import {styleKind} from './style.ts';
import {svelteKind} from './svelte.ts';
import {vueKind} from './vue.ts';

// Key order is the registry order: shared kinds first, then the targets in `TARGETS` order.
const KINDS_BY_TAG: Record<BlockTag, BlockKind> = {style: styleKind, vue: vueKind, react: reactKind, svelte: svelteKind};

export const BLOCK_KINDS: readonly BlockKind[] = Object.values(KINDS_BY_TAG);

export function getBlockKind(tag: BlockTag): BlockKind {
  return KINDS_BY_TAG[tag];
}
