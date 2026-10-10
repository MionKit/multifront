// LanguagePlugin's `typescript` field is an augmentation in @volar/typescript; tsc drops a type-only import of it from the .d.ts.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference types="@volar/typescript" preserve="true" />
import {getBlockKind, splitBlocks} from '@multifront/core';
import type {Block, BlockTag, SplitResult, Target, VirtualFile} from '@multifront/core';
import type {IScriptSnapshot, LanguagePlugin, VirtualCode} from '@volar/language-core';
import type {TypeScriptServiceScript} from '@volar/typescript';
import type * as ts from 'typescript';
import {EDITOR_BLOCK_KINDS} from './blocks/index.ts';
import {ALL_FEATURES} from './mappings.ts';
import type {EditorContext} from './types.ts';

const LANGUAGE_ID_BY_EXT: Record<VirtualFile['ext'], string> = {
  '.tsx': 'typescriptreact',
  '.ts': 'typescript',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

// The id of the code tsserver serves as the `.ucf` file's own script.
const REACT_CODE_ID = 'react';

function stringSnapshot(text: string): IScriptSnapshot {
  return {getText: (start, end) => text.slice(start, end), getLength: () => text.length, getChangeRange: () => undefined};
}

// A target row gets its first block only, as the build does; a shared row gets every block of its tag.
function blocksOf(tag: BlockTag, split: SplitResult): Block[] {
  if (getBlockKind(tag).role === 'shared') return split.blocks.filter((block) => block.type === tag);
  const block = split.targets[tag as Target];
  return block ? [block] : [];
}

function codeId(block: Block): string {
  return getBlockKind(block.type).role === 'shared' ? `${block.type}_${block.index}` : block.type;
}

function createRootCode(fileName: string, snapshot: IScriptSnapshot): VirtualCode {
  const source = snapshot.getText(0, snapshot.getLength());
  const ctx: EditorContext = {split: splitBlocks(source, fileName), modules: {}};
  const embeddedCodes: VirtualCode[] = [];
  for (const kind of EDITOR_BLOCK_KINDS) {
    for (const block of blocksOf(kind.tag, ctx.split)) {
      for (const file of kind.editor?.(block, ctx) ?? []) {
        const {code, ext, mappings} = file;
        embeddedCodes.push({id: codeId(block), languageId: LANGUAGE_ID_BY_EXT[ext], snapshot: stringSnapshot(code), mappings});
      }
    }
  }
  const mappings = [{sourceOffsets: [0], generatedOffsets: [0], lengths: [source.length], data: ALL_FEATURES}];
  return {id: 'root', languageId: 'ucf', snapshot, mappings, embeddedCodes};
}

/** The Volar language plugin for `.ucf` files: a root code per file, one embedded code per block a service reads. */
export function createUcfLanguagePlugin(): LanguagePlugin<string> {
  return {
    getLanguageId: (fileName) => (fileName.endsWith('.ucf') ? 'ucf' : undefined),
    createVirtualCode: (fileName, languageId, snapshot) =>
      languageId === 'ucf' ? createRootCode(fileName, snapshot) : undefined,
    typescript: {
      extraFileExtensions: [{extension: 'ucf', isMixedContent: true, scriptKind: 7 satisfies ts.ScriptKind.Deferred}],
      // Volar's tsserver plugin serves no extra scripts, so the React code is the file's own script.
      getServiceScript(root): TypeScriptServiceScript | undefined {
        const code = root.embeddedCodes?.find(({id}) => id === REACT_CODE_ID);
        return code && {code, extension: '.tsx', scriptKind: 4 satisfies ts.ScriptKind.TSX};
      },
    },
  };
}
