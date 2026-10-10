import type {BlockTag} from '@multifront/core';
import type {EditorBlockKind} from '../types.ts';
import {reactEditorKind} from './react.ts';
import {styleEditorKind} from './style.ts';
import {svelteEditorKind} from './svelte.ts';
import {vueEditorKind} from './vue.ts';

// Key order = core's `BLOCK_KINDS` order: shared kinds first, so they fill the context the targets read.
const KINDS_BY_TAG: Record<BlockTag, EditorBlockKind> = {
  style: styleEditorKind,
  vue: vueEditorKind,
  react: reactEditorKind,
  svelte: svelteEditorKind,
};

export const EDITOR_BLOCK_KINDS: readonly EditorBlockKind[] = Object.values(KINDS_BY_TAG);
