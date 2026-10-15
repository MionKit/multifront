import {DiagnosticsError, createDiagnostic} from '../diagnostics.ts';
import {findClosingTag} from '../scan.ts';
import type {Block, BlockKind, BlockTag, BuildContext, Diagnostic, SplitResult, Target, VirtualFile} from '../types.ts';
import {reactKind} from './react.ts';
import {styleKind} from './style.ts';
import {svelteKind, svelteTags} from './svelte.ts';
import {vueKind, vueTags} from './vue.ts';

// Key order = registry order: shared kinds first, then targets in `TARGETS` order.
const KINDS_BY_TAG: Record<BlockTag, BlockKind> = {style: styleKind, vue: vueKind, react: reactKind, svelte: svelteKind};

export const BLOCK_KINDS: readonly BlockKind[] = Object.values(KINDS_BY_TAG);

export function getBlockKind(tag: BlockTag): BlockKind {
  return KINDS_BY_TAG[tag];
}

/** Each root `<script>` of a `<vue>` or `<svelte>` block, as a block of that type: its own tag, attributes and text. */
export function blockScripts(block: Block): Block[] {
  const tags = block.type === 'vue' ? vueTags(block) : block.type === 'svelte' ? svelteTags(block) : [];
  return tags
    .filter(({name, end}) => name === 'script' && !block.content.startsWith('/>', end - 2))
    .map(({attrs, start, end}) => {
      const close = findClosingTag(block.content, 'script', end) ?? {start: block.content.length, end: block.content.length};
      const at = (offset: number) => block.contentStart + offset;
      const content = block.content.slice(end, close.start);
      return {...block, attrs, content, start: at(start), end: at(close.end), contentStart: at(end), contentEnd: at(close.start)};
    });
}

/** Hosts call this, never the kinds' `check` one by one. */
export function checkBlocks(split: SplitResult): Diagnostic[] {
  const blockErrors = split.blocks.flatMap((block) => getBlockKind(block.type).check(block, split));
  return [...split.errors, ...blockErrors].sort((first, second) => first.start - second.start);
}

/** The file one target becomes; throws `DiagnosticsError` on the splitter's and that block's errors. */
export function buildTarget(split: SplitResult, ctx: BuildContext, target: Target): VirtualFile {
  const block = split.targets[target];
  if (!block) {
    throw new DiagnosticsError([
      createDiagnostic(split, 'missing-target-block', 0, 0, `${split.filename} has no <${target}> block`),
    ]);
  }
  const kind = getBlockKind(target);
  // Style errors belong to the style modules, other targets' to their own builds: one problem, one error.
  const errors = [...split.errors, ...kind.check(block, split)].sort((first, second) => first.start - second.start);
  if (errors.length > 0) throw new DiagnosticsError(errors);
  return kind.build(block, ctx);
}
