import {styleInsideTarget} from '../diagnostics.ts';
import type {BlockKind} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
export const svelteKind: BlockKind = {
  tag: 'svelte',
  role: 'target',
  grammar: {scopeName: 'source.svelte', languageId: 'svelte'},
  check: (block, split) => styleInsideTarget(block, split, (name) => !VOID_ELEMENTS.has(name)),
};
