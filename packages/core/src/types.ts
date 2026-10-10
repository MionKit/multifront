import type * as CompilerSfc from '@vue/compiler-sfc';

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
  | 'style-inside-target'
  | 'unknown-style-lang'
  | 'duplicate-style-module'
  | 'style-compile-error';

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

/** The part of @vue/compiler-sfc core calls; hosts pass the one their Vue ships. */
export type VueCompiler = Pick<typeof CompilerSfc, 'compileStyleAsync' | 'parse' | 'MagicString'>;

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
