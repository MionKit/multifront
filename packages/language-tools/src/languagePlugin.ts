// The `typescript` field is a @volar/typescript augmentation; tsc drops a type-only import of it from the .d.ts.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference types="@volar/typescript" preserve="true" />
import {isTarget, splitBlocks} from '@multifront/core';
import type {Block, VirtualFile} from '@multifront/core';
import type {IScriptSnapshot, LanguagePlugin, VirtualCode} from '@volar/language-core';
import type {TypeScriptServiceScript} from '@volar/typescript';
import type * as ts from 'typescript';
import {createEditorContext, editorFiles} from './context.ts';
import {ALL_FEATURES} from './mappings.ts';
import type {EditorOptions, UcfVirtualCode} from './types.ts';

const LANGUAGE_ID_BY_EXT: Record<VirtualFile['ext'], string> = {
  '.tsx': 'typescriptreact',
  '.ts': 'typescript',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

function stringSnapshot(text: string): IScriptSnapshot {
  return {getText: (start, end) => text.slice(start, end), getLength: () => text.length, getChangeRange: () => undefined};
}

function codeId(block: Block): string {
  return isTarget(block.type) ? block.type : `${block.type}_${block.index}`;
}

function createRootCode(fileName: string, snapshot: IScriptSnapshot, options: EditorOptions): UcfVirtualCode {
  const source = snapshot.getText(0, snapshot.getLength());
  const split = splitBlocks(source, fileName);
  const ctx = createEditorContext(split, options);
  const embeddedCodes: VirtualCode[] = editorFiles(ctx).map(({block, file: {code, ext, mappings}}) => ({
    id: codeId(block),
    languageId: LANGUAGE_ID_BY_EXT[ext],
    snapshot: stringSnapshot(code),
    mappings,
  }));
  const mappings = [{sourceOffsets: [0], generatedOffsets: [0], lengths: [source.length], data: ALL_FEATURES}];
  return {id: 'root', languageId: 'ucf', snapshot, mappings, embeddedCodes, split};
}

/** The Volar language plugin for `.ucf` files: a root code per file, one embedded code per block a service reads. */
export function createUcfLanguagePlugin(options: EditorOptions = {}): LanguagePlugin<string> {
  return {
    getLanguageId: (fileName) => (fileName.endsWith('.ucf') ? 'ucf' : undefined),
    createVirtualCode: (fileName, languageId, snapshot) =>
      languageId === 'ucf' ? createRootCode(fileName, snapshot, options) : undefined,
    typescript: {
      extraFileExtensions: [{extension: 'ucf', isMixedContent: true, scriptKind: 7 satisfies ts.ScriptKind.Deferred}],
      // Volar's tsserver plugin serves no extra scripts, so the React code is the file's own script.
      getServiceScript(root): TypeScriptServiceScript | undefined {
        const code = root.embeddedCodes?.find(({id}) => id === 'react');
        return code && {code, extension: '.tsx', scriptKind: 4 satisfies ts.ScriptKind.TSX};
      },
    },
  };
}
