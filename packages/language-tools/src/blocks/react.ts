import type {Block} from '@multifront/core';
import type {CodeMapping} from '@volar/language-core';
import {contentMapping} from '../mappings.ts';
import {declareModule, IDENTIFIER} from '../moduleTypes.ts';
import type {EditorBlockKind, EditorContext, EditorFile} from '../types.ts';

// The block, then `declare const $style: {readonly card: string};` per module.
function types(block: Block, ctx: EditorContext): EditorFile {
  const mappings: CodeMapping[] = [contentMapping(block)];
  let code = block.content;
  for (const module of Object.values(ctx.modules)) {
    if (IDENTIFIER.test(module.name)) code = declareModule(code, module.name, module.classes, mappings);
  }
  return {ext: '.tsx', code, map: undefined, mappings};
}

function editor(block: Block, ctx: EditorContext): EditorFile[] {
  return [types(block, ctx)];
}

export const reactEditorKind: EditorBlockKind = {tag: 'react', types, editor};
