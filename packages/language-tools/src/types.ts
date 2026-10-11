import type {
  Block,
  BlockTag,
  Diagnostic,
  ResolveTargetOptions,
  SplitResult,
  StyleModule,
  Target,
  VirtualFile,
  VueCompiler,
} from '@multifront/core';
import type {CodeMapping, VirtualCode} from '@volar/language-core';
import type {TypeScriptServiceScript} from '@volar/typescript';
import type * as ts from 'typescript';

/** Editor half of a core `BlockKind`; `blocks/` holds one per core kind, same tags, same order. */
export interface EditorBlockKind {
  tag: BlockTag;
  types?(block: Block, ctx: EditorContext): EditorFile | undefined; // what an importer sees: Card.ucf.<target><ext>
  editor?(block: Block, ctx: EditorContext): EditorCode[]; // embedded codes for the language services
  serviceScript?(code: VirtualCode): TargetScript | undefined; // inside the code editor() made
}

/** A file the row turns into a code, or a Volar code it builds itself (`<vue>`: a `VueVirtualCode`). */
export type EditorCode = EditorFile | VirtualCode;

/** What tsserver serves as `Card.ucf.<target>.ts`, beside the `.ucf` file's own script. */
export type TargetScript = Pick<TypeScriptServiceScript, 'code' | 'scriptKind'>;

/** A v3 source map has no exact spans and no per-span feature flags, so editor files carry Volar mappings. */
export interface EditorFile extends VirtualFile {
  mappings: CodeMapping[]; // Volar offsets with feature flags; `map` stays undefined
}

export interface EditorOptions {
  compiler?: VueCompiler; // without it, only plain CSS modules are read
  ts?: TypeScript; // without it, no `<vue>` code
  compilerOptions?: ts.CompilerOptions;
  vueTypesRoot?: string; // folder of language-core's `types/*.d.ts`; default: the installed `@vue/language-core`'s
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

/** The `typescript` module a host hands us; CommonJS typings of it carry no `default`. */
export type TypeScript = Omit<typeof ts, 'default'>;

/** `resolveUcfImport` input, from the tsserver plugin or a `tsc` host. */
export interface UcfImportOptions extends ResolveTargetOptions {
  compilerOptions: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
  getSplit(fileName: string): SplitResult | undefined; // the open buffer, if any; else `host` reads the file
}

/** Plus the error the plugin reports at the import. */
export interface UcfResolution extends ts.ResolvedModuleWithFailedLookupLocations {
  target?: Target; // undefined when `resolveTarget` gave an error
  error?: Pick<Diagnostic, 'code' | 'message'> & Partial<Pick<Diagnostic, 'start' | 'end'>>; // no span: the specifier
}
