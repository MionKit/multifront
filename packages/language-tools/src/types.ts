import type {Block, BlockTag, SplitResult, StyleModule, VirtualFile, VueCompiler} from '@multifront/core';
import type {CodeMapping, VirtualCode} from '@volar/language-core';

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

export interface EditorOptions {
  compiler?: VueCompiler; // without it, only plain CSS modules are read
}

/** One per `.ucf` file; shared rows fill it before the target rows read it. */
export interface EditorContext extends EditorOptions {
  split: SplitResult;
  modules: Record<string, EditorStyleModule>; // '$style' or the module name
}

/** Root code of a `.ucf` file; keeps its split so services never split the file again. */
export interface UcfVirtualCode extends VirtualCode {
  split: SplitResult;
}

export interface EditorStyleModule extends Pick<StyleModule, 'name' | 'index'> {
  classes: StyleClass[] | undefined; // undefined: the block could not be read
}

/** One key the build's CSS module exports: a class, `@keyframes`, `@value` or `:export` name. */
export interface StyleClass {
  name: string;
  offset?: number; // offset of the name in the .ucf file (`card` in `.card`), when written there
}
