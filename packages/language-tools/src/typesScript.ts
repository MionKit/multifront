import {splitBlocks} from '@multifront/core';
import type {Target} from '@multifront/core';
import {EDITOR_BLOCK_KINDS} from './blocks/index.ts';
import {createEditorContext, editorFiles} from './context.ts';
import type {EditorFile, EditorOptions} from './types.ts';

/** `Card.ucf.<target><ext>` without a language server; undefined with no such block or no `types()` for it yet. */
export function getTypesScript(
  filename: string,
  source: string,
  target: Target,
  options: EditorOptions = {}
): EditorFile | undefined {
  const ctx = createEditorContext(splitBlocks(source, filename), options);
  editorFiles(ctx, true);
  const block = ctx.split.targets[target];
  const kind = EDITOR_BLOCK_KINDS.find(({tag}) => tag === target);
  return block && kind?.types?.(block, ctx);
}
