import type {Block} from '@multifront/core';
import {contentMapping} from '../mappings.ts';
import type {EditorBlockKind, EditorFile} from '../types.ts';

// The langs the CSS service reads; the others are highlighting only.
const EXT_BY_LANG: Record<string, EditorFile['ext']> = {css: '.css', scss: '.scss'};

function editor(block: Block): EditorFile[] {
  const {lang = 'css'} = block.attrs;
  if (typeof lang !== 'string' || !Object.hasOwn(EXT_BY_LANG, lang)) return [];
  return [{ext: EXT_BY_LANG[lang]!, code: block.content, map: undefined, mappings: [contentMapping(block)]}];
}

export const styleEditorKind: EditorBlockKind = {tag: 'style', editor};
