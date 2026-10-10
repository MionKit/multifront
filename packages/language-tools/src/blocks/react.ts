import type {Block} from '@multifront/core';
import type {CodeMapping} from '@volar/language-core';
import {contentMapping} from '../mappings.ts';
import type {EditorBlockKind, EditorContext, EditorFile, StyleClass} from '../types.ts';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// An unreadable module (a style mid-edit) must not turn every `$style.x` red; its own service reports the error.
const LOOSE_MODULE = '{readonly [name: string]: string}';

// Appends `declare const $style: {readonly card: string};` after the block, one line per module.
function types(block: Block, ctx: EditorContext): EditorFile {
  const mappings: CodeMapping[] = [contentMapping(block)];
  let code = block.content;
  for (const module of Object.values(ctx.modules)) {
    if (!IDENTIFIER.test(module.name)) continue;
    if (!code.endsWith('\n')) code += '\n';
    code += `declare const ${module.name}: `;
    code += module.classes ? moduleType(module.classes, code.length, mappings) : LOOSE_MODULE;
    code += ';\n';
  }
  return {ext: '.tsx', code, map: undefined, mappings};
}

// Each written key jumps to its name in the style block: navigation only, the rest is ours.
function moduleType(classes: StyleClass[], start: number, mappings: CodeMapping[]): string {
  let text = '{';
  for (const [i, {name, offset}] of classes.entries()) {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    text += `${i > 0 ? '; ' : ''}readonly `;
    // Only plain CSS names get an offset, so a quoted key is the name plus its two quotes.
    if (offset !== undefined) {
      const keyStart = start + text.length + (key === name ? 0 : 1);
      mappings.push({sourceOffsets: [offset], generatedOffsets: [keyStart], lengths: [name.length], data: {navigation: true}});
    }
    text += `${key}: string`;
  }
  return `${text}}`;
}

function editor(block: Block, ctx: EditorContext): EditorFile[] {
  return [types(block, ctx)];
}

export const reactEditorKind: EditorBlockKind = {tag: 'react', types, editor};
