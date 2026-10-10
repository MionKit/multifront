import type {IRawGrammar} from 'vscode-textmate';

/** One TextMate rule as JSON. */
export type TmRule = IRawGrammar['patterns'][number];

/** A TextMate grammar as JSON; the root .ucf grammar has no repository. */
export type TmGrammar = Omit<IRawGrammar, 'repository'> & {repository?: IRawGrammar['repository']};

/** One grammar file of the extension. */
export interface GrammarFile {
  scopeName: string;
  path: string; // file name under the extension's syntaxes folder
  grammar: TmGrammar;
  injectTo?: string[]; // root scopes this injection grammar applies to
}
