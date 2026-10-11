import type {Block} from '@multifront/core';
import type {CodeInformation, CodeMapping, IScriptSnapshot} from '@volar/language-core';

/** A generated text as Volar reads it; no change range, so every edit is a full reparse. */
export function stringSnapshot(text: string): IScriptSnapshot {
  return {getText: (start, end) => text.slice(start, end), getLength: () => text.length, getChangeRange: () => undefined};
}

/** Every language feature on: the generated text is the user's own. */
export const ALL_FEATURES: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
  format: true,
};

/** The block content, 1:1 at the start of the generated code. */
export function contentMapping(block: Block): CodeMapping {
  return {sourceOffsets: [block.contentStart], generatedOffsets: [0], lengths: [block.content.length], data: ALL_FEATURES};
}
