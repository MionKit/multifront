// Tokenizes a .ucf file the way VS Code does: the real vscode-textmate on the real oniguruma WASM.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {GrammarFile} from 'multifront-vscode/grammar';
import {bundledLanguages} from 'shiki';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';
import type {IRawGrammar} from 'vscode-textmate';

export interface ScopedToken {
  start: number; // offsets into the file
  end: number;
  scopes: string[];
}

const require = createRequire(import.meta.url);

let onigLib: Promise<textmate.IOnigLib> | undefined;
let builtins: Promise<Map<string, IRawGrammar>> | undefined;

// loadWASM may run once per process.
function loadOnigLib(): Promise<textmate.IOnigLib> {
  onigLib ??= oniguruma.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer).then(() => ({
    createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
    createOnigString: (text) => new oniguruma.OnigString(text),
  }));
  return onigLib;
}

// The grammars VS Code ships built in (source.tsx, source.css, text.html.basic, ...), by scope name.
function loadBuiltins(): Promise<Map<string, IRawGrammar>> {
  builtins ??= Promise.all(Object.values(bundledLanguages).map((load) => load())).then((modules) => {
    const byScope = new Map<string, IRawGrammar>();
    for (const grammar of modules.flatMap((module) => module.default)) {
      if (!byScope.has(grammar.scopeName)) byScope.set(grammar.scopeName, grammar as unknown as IRawGrammar);
    }
    return byScope;
  });
  return builtins;
}

/** TextMate's rule: `meta.embedded` matches `meta.embedded.block.react`, not `meta.embeddedx`. */
export function hasScope(token: ScopedToken, scope: string): boolean {
  return token.scopes.some((name) => name === scope || name.startsWith(`${scope}.`));
}

/** `grammars[0]` is the root; the others load when it includes or injects them. */
export async function tokenizeUcf(path: string, grammars: GrammarFile[]): Promise<ScopedToken[]> {
  const [lib, builtin] = await Promise.all([loadOnigLib(), loadBuiltins()]);
  // Ours go through JSON text, as VS Code reads them from the extension's files.
  const ours = new Map(
    grammars.map((file) => [file.scopeName, textmate.parseRawGrammar(JSON.stringify(file.grammar), file.path)])
  );
  const registry = new textmate.Registry({
    onigLib: Promise.resolve(lib),
    loadGrammar: async (scopeName) => ours.get(scopeName) ?? builtin.get(scopeName) ?? null,
    getInjections: (scopeName) => grammars.filter((file) => file.injectTo?.includes(scopeName)).map((file) => file.scopeName),
  });
  const grammar = await registry.loadGrammar(grammars[0]!.scopeName);
  if (!grammar) throw new Error(`no grammar for ${grammars[0]!.scopeName}`);
  const tokens: ScopedToken[] = [];
  let state = textmate.INITIAL;
  let offset = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const {startIndex, endIndex, scopes} of result.tokens) {
      // The last token can reach past the line: the tokenizer adds the newline.
      const end = Math.min(endIndex, line.length);
      if (end > startIndex) tokens.push({start: offset + startIndex, end: offset + end, scopes});
    }
    offset += line.length + 1;
  }
  return tokens;
}
