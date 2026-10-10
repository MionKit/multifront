import type {Block} from '@multifront/core';
import type {CodeInformation, CodeMapping} from '@volar/language-core';

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
