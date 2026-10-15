// The `typescript` field is a @volar/typescript augmentation; tsc drops a type-only import of it from the .d.ts.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference types="@volar/typescript" preserve="true" />
import {isTarget, splitBlocks} from '@multifront/core';
import type {Block, Target, VirtualFile} from '@multifront/core';
import type {IScriptSnapshot, LanguagePlugin, VirtualCode} from '@volar/language-core';
import type {TypeScriptServiceScript} from '@volar/typescript';
import type * as ts from 'typescript';
import {disposeVueCode, forwardToVueCode} from './blocks/vue.ts';
import {createEditorContext, editorFiles} from './context.ts';
import {ALL_FEATURES, stringSnapshot} from './mappings.ts';
import type {EditorOptions, UcfVirtualCode} from './types.ts';

const LANGUAGE_ID_BY_EXT: Record<VirtualFile['ext'], string> = {
  '.tsx': 'typescriptreact',
  '.ts': 'typescript',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/** Target served as the `.ucf` file's own script: Volar's tsserver plugin serves no extra scripts. */
export const MAIN_SCRIPT_TARGET = 'react' satisfies Target;

// Without one, tsserver reads the raw `.ucf` text as TSX; one per root, so Volar's mapping cache holds.
const emptyScripts = new WeakMap<VirtualCode, VirtualCode>();

function emptyScript(root: VirtualCode): VirtualCode {
  let code = emptyScripts.get(root);
  if (!code) {
    code = {id: MAIN_SCRIPT_TARGET, languageId: 'typescriptreact', snapshot: stringSnapshot('export {};\n'), mappings: []};
    emptyScripts.set(root, code);
  }
  return code;
}

function codeId(block: Block): string {
  return isTarget(block.type) ? block.type : `${block.type}_${block.index}`;
}

function createRootCode(fileName: string, snapshot: IScriptSnapshot, options: EditorOptions, last?: VirtualCode): UcfVirtualCode {
  const source = snapshot.getText(0, snapshot.getLength());
  const split = splitBlocks(source, fileName);
  const ctx = createEditorContext(split, options, last);
  const embeddedCodes: VirtualCode[] = editorFiles(ctx).map(({block, file}) => {
    // A code the row built carries its own id: a block may give several.
    if (!('ext' in file)) return file;
    const {code, ext, mappings} = file;
    return {id: codeId(block), languageId: LANGUAGE_ID_BY_EXT[ext], snapshot: stringSnapshot(code), mappings};
  });
  const mappings = [{sourceOffsets: [0], generatedOffsets: [0], lengths: [source.length], data: ALL_FEATURES}];
  const root: UcfVirtualCode = {id: 'root', languageId: 'ucf', snapshot, mappings, embeddedCodes, split};
  const vue = embeddedCodes.find(({id}) => id === 'vue');
  if (vue) forwardToVueCode(root, vue);
  return root;
}

/** The Volar language plugin for `.ucf` files: a root code per file, one embedded code per block a service reads. */
export function createUcfLanguagePlugin(options: EditorOptions = {}): LanguagePlugin<string> {
  return {
    getLanguageId: (fileName) => (fileName.endsWith('.ucf') ? 'ucf' : undefined),
    createVirtualCode: (fileName, languageId, snapshot) =>
      languageId === 'ucf' ? createRootCode(fileName, snapshot, options) : undefined,
    // A block that does not build now serves its code from the last root.
    updateVirtualCode: (fileName, root, snapshot) => createRootCode(fileName, snapshot, options, root),
    disposeVirtualCode(fileName, root) {
      const vue = root.embeddedCodes?.find(({id}) => id === 'vue');
      if (vue) disposeVueCode(fileName, vue, options);
    },
    typescript: {
      extraFileExtensions: [{extension: 'ucf', isMixedContent: true, scriptKind: 7 satisfies ts.ScriptKind.Deferred}],
      getServiceScript(root): TypeScriptServiceScript {
        const code = root.embeddedCodes?.find(({id}) => id === MAIN_SCRIPT_TARGET) ?? emptyScript(root);
        return {code, extension: '.tsx', scriptKind: 4 satisfies ts.ScriptKind.TSX};
      },
    },
  };
}
