import {createDiagnostic} from '../diagnostics.ts';
import {topLevelTags} from '../scan.ts';
import type {Block, BlockKind, Diagnostic, SplitResult} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
function check(block: Block, split: SplitResult): Diagnostic[] {
  const message = '<style> cannot sit inside the <svelte> block; move it to the root of the file';
  return topLevelTags(block.content, (name) => !VOID_ELEMENTS.has(name))
    .filter((tag) => tag.name === 'style')
    .map((tag) =>
      createDiagnostic(split, 'style-inside-target', block.contentStart + tag.start, block.contentStart + tag.end, message)
    );
}

export const svelteKind: BlockKind = {tag: 'svelte', role: 'target', check};
