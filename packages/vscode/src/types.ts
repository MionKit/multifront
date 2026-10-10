/** One TextMate rule as JSON; VS Code reads it, we only rename scopes in it. */
export type TmRule = {[key: string]: unknown};

/** A TextMate grammar as JSON. */
export interface TmGrammar {
  scopeName: string;
  patterns: TmRule[];
  repository?: Record<string, TmRule>;
  injections?: Record<string, TmRule>; // selector → rule; VS Code reads these from the document's root grammar only
  injectionSelector?: string;
  [key: string]: unknown;
}

/** One grammar file of the extension. */
export interface GrammarFile {
  scopeName: string;
  path: string; // file name under the extension's syntaxes folder
  grammar: TmGrammar;
  injectTo?: string[]; // root scopes this injection grammar applies to
}
