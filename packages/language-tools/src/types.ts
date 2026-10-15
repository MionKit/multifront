import type {
  Block,
  BlockTag,
  Diagnostic,
  Finding,
  ResolveTargetOptions,
  SplitResult,
  StyleModule,
  SvelteCompiler,
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
  svelteCompiler?: SvelteCompiler; // without it, no `<svelte>` code
  svelteTypesRoot?: string; // folder of svelte2tsx's shims; default: the installed `svelte2tsx`
}

export interface EmitSvelteTypesOptions extends Pick<EditorOptions, 'ts' | 'svelteTypesRoot'> {
  root: string; // every `.ucf` file under it with a `<svelte>` block gets a declaration
  outDir?: string; // default `<root>/.ucf/svelte`; `ts` defaults to the project's own, resolved from `root`
}

/** What a host bundling the language server sets. */
export interface ServerOptions extends Pick<EditorOptions, 'svelteTypesRoot'> {
  onTypeScript?(ts: TypeScript): void; // called with the tsdk's TypeScript once it is loaded
}

/** One per `.ucf` file; shared rows fill it before the target rows read it. */
export interface EditorContext extends EditorOptions {
  split: SplitResult;
  modules: Record<string, EditorStyleModule>; // '$style' or the module name
  previous?: VirtualCode; // the file's root code before this edit, in the language plugin only
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

/** One tsconfig's program in `mf-tsc`, with every `.ucf` file's target scripts in it. */
export interface Checked {
  program: ts.Program;
  getSplit(fileName: string): SplitResult | undefined;
  files(): string[]; // the user's files: no default lib, no `node_modules`, no target script
  check(fileName: string, targets: readonly Target[]): CheckedFile;
}

/** One file's problems, already in the file the user wrote. */
export interface CheckedFile {
  diagnostics: {diagnostic: ts.Diagnostic; target?: Target}[]; // `target`: the `.ucf` script that reported it
  errors: {error: Diagnostic; target: 'svelte'}[]; // ours: `<svelte>` markup Svelte cannot parse
}

/** An element or a `{#…}` block open at some offset in the `<svelte>` markup. */
export interface MarkupOpen {
  kind: 'element' | 'block';
  name: string;
  branch: string; // a block's current `{#…}` or `{:…}` name
  clauses: Set<string>; // a block's `{:…}` names in the whole content, and `then` / `catch` in its `{#await …}`
}

export interface MarkupEvent extends Pick<MarkupOpen, 'kind' | 'name'>, Partial<Pick<MarkupOpen, 'branch' | 'clauses'>> {
  at: number; // just after the tag or the `}`
  type: 'open' | 'close' | 'branch'; // an open block's `clauses` fill while scanning, shared by its `MarkupOpen`s
}

export interface MarkupSpan {
  start: number;
  end: number;
}

/** `end` is the next `<` or the content end while the tag is still being typed. */
export interface MarkupTag extends MarkupSpan {
  name: string;
  gaps: MarkupSpan[]; // whitespace between the name, the attributes and the tag's end; never inside a value
}

/** The `<svelte>` markup read lexically, in offsets of the block content. */
export interface MarkupScan {
  code: string; // same length as the content: `<script>` contents and every `{…}` blanked
  pieces: MarkupSpan[]; // the spans `code` keeps as written
  events: MarkupEvent[];
  opaque: (MarkupSpan & {expression: boolean})[]; // tags, comments, raw text and expressions: no markup completes there
  hasScript: boolean; // a top-level instance `<script>`
  metas: Set<string>; // top-level `svelte:*` elements; Svelte takes each meta element once
  tags: MarkupTag[]; // every start tag, in order
}

/** oxfmt options as its config files write them; oxfmt validates them. */
export type FormatOptions = Record<string, unknown>;

/** One `overrides` entry of an `.oxfmtrc.json`. */
export interface FormatOverride {
  files: string[];
  excludeFiles?: string[];
  options?: FormatOptions;
}

/** One `.editorconfig`: its `[glob]` sections in order, keys and values lower-cased. */
export interface EditorConfigFile {
  file: string;
  sections: {glob: string; properties: Record<string, string>}[];
}

/** One `.ucf` file's oxfmt config, as the oxfmt CLI reads it; `formatUcf` resolves it per block file. */
export interface UcfFormatConfig {
  root: string; // oxfmt loads from here (the cwd, or the server's workspace folder)
  file?: string; // the `.oxfmtrc.json` / `.oxfmtrc.jsonc`; undefined: oxfmt's defaults
  options: FormatOptions; // its options, without `overrides`, `ignorePatterns` and `$schema`
  overrides: FormatOverride[];
  ignorePatterns: string[]; // against the `.ucf` path, relative to the config's folder
  editorconfig?: EditorConfigFile; // the nearest at or above `root`, as the oxfmt CLI reads one
}

/** `text` is the source as is whenever there are findings. */
export interface FormattedUcf {
  text: string;
  findings: Finding[];
  missingSvelte: boolean; // a `<svelte>` block the config formats stayed as written: oxfmt cannot load `svelte/compiler`
}

/** One oxlint diagnostic of a `.ucf` file, its span in that file. */
export interface UcfLintDiagnostic {
  file: string; // the split's filename
  start: number; // UTF-16 offsets into the .ucf source
  end: number;
  block: Target; // the block oxlint linted
  code: string; // oxlint's: `eslint(no-debugger)`
  message: string;
  severity: Diagnostic['severity'] | 'advice';
  url?: string;
  help?: string;
}
