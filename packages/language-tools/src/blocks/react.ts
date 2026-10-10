import type {Block} from '@multifront/core';
import {contentMapping} from '../mappings.ts';
import type {EditorBlockKind, EditorFile} from '../types.ts';

function editor(block: Block): EditorFile[] {
  return [{ext: '.tsx', code: block.content, map: undefined, mappings: [contentMapping(block)]}];
}

export const reactEditorKind: EditorBlockKind = {tag: 'react', editor};
