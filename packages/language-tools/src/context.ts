import {isTarget} from '@multifront/core';
import type {Block, BlockTag, SplitResult} from '@multifront/core';
import {EDITOR_BLOCK_KINDS} from './blocks/index.ts';
import type {EditorCode, EditorContext, EditorOptions} from './types.ts';

export function createEditorContext(split: SplitResult, options: EditorOptions): EditorContext {
  return {...options, split, modules: {}};
}

// Targets get their first block only, as the build does; shared kinds get every block.
function blocksOf(tag: BlockTag, split: SplitResult): Block[] {
  if (!isTarget(tag)) return split.blocks.filter((block) => block.type === tag);
  const block = split.targets[tag];
  return block ? [block] : [];
}

/** Every row's `editor()` in registry order, so shared rows fill `ctx` before the targets read it. */
export function editorFiles(ctx: EditorContext, sharedOnly = false): {block: Block; file: EditorCode}[] {
  const files: {block: Block; file: EditorCode}[] = [];
  for (const kind of EDITOR_BLOCK_KINDS) {
    if (sharedOnly && isTarget(kind.tag)) continue;
    for (const block of blocksOf(kind.tag, ctx.split)) {
      for (const file of kind.editor?.(block, ctx) ?? []) files.push({block, file});
    }
  }
  return files;
}
