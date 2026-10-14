import type {ParseArgsOptionDescriptor} from 'node:util';
import type * as CompilerSfc from '@vue/compiler-sfc';
import type * as SvelteCompilerModule from 'svelte/compiler';
import type {ROOT_PROPS} from './react/reactApis.ts';
import type {SVELTE_ROOT_PROPS} from './svelte/rootProps.ts';

/** The frameworks a component file can hold one implementation for. */
export type Target = 'vue' | 'react' | 'svelte';

/** Every root tag of a `.ucf` file. */
export type BlockTag = 'style' | Target;

/** `target` = a framework component, `shared` = used by every target. */
export type BlockRole = 'shared' | 'target';

export interface Block {
  type: BlockTag;
  attrs: Record<string, string | true>; // bare `scoped` → true; a repeated name: last wins
  content: string; // raw text between the opening and closing tag
  start: number; // offset of the '<' of the opening tag
  end: number; // offset just after the '>' of the closing tag
  contentStart: number; // offset just after the '>' of the opening tag
  contentEnd: number; // offset of the '<' of the closing tag
  index: number; // position among the blocks of the same type, in source order
}

export interface SplitResult {
  filename: string;
  source: string;
  blocks: Block[]; // every root block, in source order
  styles: Block[]; // the <style> blocks, in source order (styles[i].index === i)
  targets: Partial<Record<Target, Block>>; // the first block of each target
  errors: Diagnostic[]; // splitter errors only
}

/** TextMate grammar for a block's content, plus its VS Code language. */
export interface GrammarScope {
  scopeName: string; // root scope, e.g. 'source.tsx'
  languageId: string; // e.g. 'typescriptreact'
}

export interface BlockGrammar extends GrammarScope {
  byLang?: Record<string, GrammarScope>; // picked by the block's lang attribute
}

/** One root tag and what it can do; the registry in `blocks/` holds one per tag. */
export interface BlockKind {
  tag: BlockTag;
  role: BlockRole;
  grammar: BlockGrammar;
  check(block: Block, split: SplitResult): Diagnostic[]; // the block's own rules; splitter errors stay in split.errors
  fillContext?(blocks: Block[], ctx: BuildContext): Promise<void>; // shared kinds only; runs before any build
  build(block: Block, ctx: BuildContext): VirtualFile;
}

/** One file a block becomes, for the bundler or an editor service. */
export interface VirtualFile {
  ext: '.tsx' | '.vue' | '.svelte' | '.css' | '.scss' | '.ts';
  code: string;
  map: SourceMap | undefined; // back to the block in the .ucf file
}

/** Why an opening tag never ends cleanly; set = the tag counts as unclosed. */
export type TagBreak = 'eof' | 'open-quote' | 'self-closing';

export type DiagnosticCode =
  | 'unknown-root-tag'
  | 'unclosed-block'
  | 'duplicate-target'
  | 'missing-target'
  | 'text-outside-block'
  | 'react-no-default-export'
  | 'react-syntax-error'
  | 'style-inside-target'
  | 'unknown-style-lang'
  | 'duplicate-style-module'
  | 'style-compile-error'
  | 'vue-only-style'
  | 'vue-empty-block'
  | 'svelte-parse-error'
  | 'missing-style-module'
  | 'missing-target-block'
  | 'mixed-frameworks'
  | 'framework-attribute-not-literal'
  | LibraryErrorCode
  | TargetErrorCode;

/** Library build errors: names, imports and files a package cannot ship. */
export type LibraryErrorCode = 'name-clash' | 'not-a-peer' | 'outside-src' | 'css-outside-style' | 'svelte-import';

/** The errors `resolveTarget` can return. */
export type TargetErrorCode = 'framework-in-block' | 'unknown-framework' | 'no-target' | 'target-not-enabled';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string; // one line, names the tag: "<react> appears more than once; keep one"
  filename: string;
  start: number; // offsets into the .ucf source
  end: number;
  line: number; // 1-based line of start
  column: number; // 0-based column of start (the Rollup / Vite `loc` convention)
}

/** A command's reported problem; line and column 1-based, always in the file the user wrote. */
export interface Finding extends Pick<Diagnostic, 'severity' | 'message'> {
  file?: string; // absolute; printers show it relative to the cwd
  line?: number;
  column?: number;
  end?: {line: number; column: number}; // just past the last character
  code: string; // ours, a tool's (`TS2322`) or a plugin's (`vite:vue`)
  block?: BlockTag; // the .ucf block the position falls in
  framework?: Target; // the framework build or check that reported it
}

/** `value` names a string option's argument in the help: `<folder>`. */
export interface CommandOption extends Pick<ParseArgsOptionDescriptor, 'type' | 'multiple'> {
  value?: string;
  description: string;
}

/** `runCommand` adds `--format` and `--help` to `options`. */
export interface CommandSpec {
  name: string;
  summary: string[];
  options: Record<string, CommandOption>;
  example: string;
}

export type CommandValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** `data` joins the JSON document. */
export interface CommandResult {
  findings: Finding[];
  summary: string;
  data?: Record<string, unknown>;
}

/** The @vue/compiler-sfc parts multifront calls; hosts pass the one their Vue ships. */
export type VueCompiler = Pick<
  typeof CompilerSfc,
  'compileScript' | 'compileStyleAsync' | 'compileStyle' | 'parse' | 'MagicString'
>;

/** How Svelte compiles a block: `undecided` has no rune and no legacy-only syntax, so the compiler option decides. */
export type SvelteMode = 'runes' | 'legacy' | 'undecided';

/** A node of Svelte's modern AST, read by key. */
export type SvelteNode = SvelteCompilerModule.AST.BaseNode & Record<string, unknown>;

/** Loaded from the project's own Svelte. */
export type SvelteCompiler = Pick<typeof SvelteCompilerModule, 'parse' | 'preprocess' | 'VERSION'>;

/** What a forwarded Svelte root accepts and merges, as React roots do `className` and `style`. */
export type SvelteRootProp = (typeof SVELTE_ROOT_PROPS)[number];

/** Svelte reads every script of a block as TypeScript or as JavaScript. */
export type SvelteScriptLang = 'ts' | 'js';

type SvelteDeclarator = Extract<
  SvelteCompilerModule.AST.Script['content']['body'][number],
  {type: 'VariableDeclaration'}
>['declarations'][number];

/** The instance script's `$props()` declarator, and the declaration that holds it. */
export interface SveltePropsDeclaration {
  declaration: SvelteNode;
  declarator: SvelteDeclarator;
}

/** The root props a component handles itself, and the names whose spread on a root hands it every prop. */
export interface HandledProps<Prop extends string> {
  handled: Set<Prop>;
  spreads: Set<string>;
}

/** A `<svelte>` block as the editor types it: `build()`'s class map rename, `$props()` edits and root-prop types. */
export interface SvelteEditorSource<Module> {
  code: string; // the block content only
  locals: Map<Module, string>; // each module used, and the local name its uses got
  lang: SvelteScriptLang; // of the block's scripts, or of the one added
  mappings: string; // a v3 source map's, back into the .ucf file
}

export interface SourceMap {
  version: 3;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompiledStyle {
  index: number; // the block's index among the <style> blocks
  id: string; // module id, from styleId()
  code: string; // plain CSS
  map: SourceMap | undefined; // back to the .ucf file
  scoped: boolean;
  module: string | undefined; // injection name: '$style' or the module="name" value
  classes: Record<string, string> | undefined; // CSS module class map, local → generated
  errors: Diagnostic[]; // 'style-compile-error', positioned in the .ucf file
}

export interface BuildContextOptions {
  root: string; // the Vite root: scope ids hash the path relative to it
  compiler: VueCompiler;
  production: boolean;
  library?: LibraryMode; // a library package build: the svelte build imports real files beside it, not virtual ids
}

/** A library package mirrors `src`: `src/forms/Field.ucf` ships as `forms/Field.svelte`. */
export interface LibraryMode {
  src: string;
}

/** What the shared kinds fill for the target builds; one per `.ucf` file. */
export interface BuildContext {
  root: string; // the Vite root: target builds load the project's compilers from it
  filename: string; // absolute .ucf path
  split: SplitResult; // every block; the vue build (M4) needs all of them
  relativePath: string; // from options.root, '/' separators: the scopeId input
  source: string;
  production: boolean;
  compiler: VueCompiler;
  scopeId: string; // 8 hex chars; the attribute is `data-v-${scopeId}`
  hasScoped: boolean; // some <style scoped> exists: target builds stamp attributes only then
  styles: CompiledStyle[]; // one per <style> block, in source order
  modules: Record<string, StyleModule>; // '$style' and named modules, by injection name
  library?: LibraryMode;
}

export interface StyleModule {
  name: string; // '$style' or the module="name" value
  index: number; // the <style> block it comes from
  id: string; // class map module id, from classMapId()
  classes: Record<string, string>; // local → generated class name
}

/** The file holding a `.ucf` import. */
export interface Importer {
  fileName: string;
  block?: Target; // the import sits inside that .ucf target block (spec 4.1)
}

export interface ResolveTargetOptions {
  frameworks?: readonly Target[]; // what this build may compile; default all (spec 7)
  framework?: Target; // the project default (spec 4.2, rule 3)
  importers?: Record<string, Target>; // importer extension → framework, over DEFAULT_IMPORTERS
}

/** Which rule of spec 4.1 / 4.2 picked the target. */
export type TargetRule = 'block' | 'attribute' | 'importer' | 'default';

export type TargetChoice = {target: Target; rule: TargetRule} | {error: {code: TargetErrorCode; message: string}};

/** One `.ucf` import found by `rewriteImportAttributes`. */
export interface UcfImport {
  kind: 'static' | 'reexport' | 'dynamic';
  specifier: string; // as written, before the rewrite
  framework?: string; // the attribute's value, not checked; unset without one or when it is not a literal
  start: number; // the specifier literal, quotes included, as offsets into the importer's code
  end: number;
}

/** What every React root accepts and merges (spec 3.5, item 5). */
export type RootProp = (typeof ROOT_PROPS)[number];

/** An element root of a `<react>` block's default export. */
export interface ReactRoot {
  tag: string; // as written: `button`, `Icon`, `motion.div`
  props: RootProp[]; // the root props the parent's value reaches here, added or merged
}

/** Where the default export's props type is written, as offsets in the block content. */
export type ReactPropsSite =
  | {kind: 'type'; start: number; end: number; wrap: boolean} // a props type; `wrap`: an intersection needs it parenthesized
  | {kind: 'argument'; at: number} // after `forwardRef<El`, which leaves the props type out
  | {kind: 'parameter'; at: number; name: string}; // right after the `(` of a component with no parameter

/** `reactRootProps`: the roots the build hands root props to, and where to type them. */
export interface ReactRootProps {
  roots: ReactRoot[];
  sites: ReactPropsSite[];
}
