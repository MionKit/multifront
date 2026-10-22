import type {IRawGrammar} from 'vscode-textmate';

export type TmRule = IRawGrammar['patterns'][number];

/** The root .front grammar has no repository. */
export type TmGrammar = Omit<IRawGrammar, 'repository'> & {repository?: IRawGrammar['repository']};

export interface GrammarFile {
  scopeName: string;
  path: string; // file name under the extension's syntaxes folder
  grammar: TmGrammar;
  injectTo?: string[]; // root scopes this injection grammar applies to
}
