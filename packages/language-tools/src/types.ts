import type {Block, BlockTag, SplitResult, StyleModule, VirtualFile} from '@multifront/core';
import type {CodeMapping} from '@volar/language-core';

/** Editor half of a core `BlockKind`; `blocks/` holds one per core kind, same tags, same order. */
export interface EditorBlockKind {
  tag: BlockTag;
  types?(block: Block, ctx: EditorContext): EditorFile; // what an importer sees: Card.ucf.<target><ext>
  editor?(block: Block, ctx: EditorContext): EditorFile[]; // embedded codes for the language services
}

/** A v3 source map has no exact spans and no per-span feature flags, so editor files carry Volar mappings. */
export interface EditorFile extends VirtualFile {
  mappings: CodeMapping[]; // Volar offsets with feature flags; `map` stays undefined
}

/** One per `.ucf` file; shared rows fill it before the target rows read it. */
export interface EditorContext {
  split: SplitResult;
  modules: Record<string, EditorStyleModule>; // '$style' or the module name
}

export interface EditorStyleModule extends Pick<StyleModule, 'name' | 'index'> {
  classes: StyleClass[];
}

export interface StyleClass {
  name: string;
  offset?: number; // offset of `.name` in the .ucf file, when written there
}
