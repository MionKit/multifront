import {readFileSync} from 'node:fs';
import {BLOCK_KINDS} from '@multifront/core';
import type {BlockKind} from '@multifront/core';
import type {GrammarFile, TmGrammar, TmRule} from './types.ts';

export type {GrammarFile, TmGrammar, TmRule} from './types.ts';

export const ROOT_SCOPE = 'source.ucf';

interface VendoredGrammar {
  dir: string; // under syntaxes/vendor/
  main: string;
  injections: string[]; // injection grammars that target the main one
}

// Pinned copies (syntaxes/vendor/sources.json), keyed by the registry scope they stand in for.
const VENDORED: Record<string, VendoredGrammar> = {
  'text.html.vue': {
    dir: 'vue',
    main: 'vue.tmLanguage.json',
    injections: ['vue-directives.json', 'vue-interpolations.json', 'vue-sfc-style-variable-injection.json'],
  },
  'source.svelte': {dir: 'svelte', main: 'svelte.tmLanguage.json', injections: []},
};

const TAG_CAPTURES = {
  1: {name: 'punctuation.definition.tag.begin.ucf'},
  2: {name: 'entity.name.tag.ucf'},
  3: {name: 'punctuation.definition.tag.end.ucf'},
};

const ATTRIBUTE: TmRule = {
  match: `([^\\s"'=<>/]+)(?:\\s*(=)\\s*(?:("[^"]*")|('[^']*')|([^\\s>]+)))?`,
  captures: {
    1: {name: 'entity.other.attribute-name.ucf'},
    2: {name: 'punctuation.separator.key-value.ucf'},
    3: {name: 'string.quoted.double.ucf'},
    4: {name: 'string.quoted.single.ucf'},
    5: {name: 'string.unquoted.ucf'},
  },
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readVendored(dir: string, file: string): TmGrammar {
  return JSON.parse(readFileSync(new URL(`../syntaxes/vendor/${dir}/${file}`, import.meta.url), 'utf8')) as TmGrammar;
}

function grammarFile(grammar: TmGrammar, injectTo?: string[]): GrammarFile {
  return {scopeName: grammar.scopeName, path: `${grammar.scopeName}.tmLanguage.json`, grammar, ...(injectTo && {injectTo})};
}

// Deep copy with every `include` passed through `rename`.
function renameIncludes<T>(node: T, rename: (include: string) => string): T {
  if (Array.isArray(node)) return node.map((item: unknown) => renameIncludes(item, rename)) as T;
  if (node === null || typeof node !== 'object') return node;
  const entries = Object.entries(node).map(([key, value]: [string, unknown]) => [
    key,
    key === 'include' && typeof value === 'string' ? rename(value) : renameIncludes(value, rename),
  ]);
  return Object.fromEntries(entries) as T;
}

// Each `,` alternative of an injection selector, narrowed to inside `scope`; a `,` in parentheses is not one.
function insideScope(selector: string, scope: string): string {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      alternatives.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(selector.slice(start));
  return alternatives
    .map((alternative) => {
      const trimmed = alternative.trim();
      const priority = /^[LRB]:/.test(trimmed) ? trimmed.slice(0, 2) : '';
      return `${priority}${scope} ${trimmed.slice(priority.length).trim()}`;
    })
    .join(', ');
}

// The splitter's tag rules: a name ends at a space, `/` or `>`; the first `</tag` then a space or `>` closes the block.
function blockRule(tag: string, contentName: string, include: string, lookahead = ''): TmRule {
  const name = escapeRegExp(tag);
  return {
    begin: `(<)(${name})(?![^\\s/>])${lookahead}`,
    beginCaptures: TAG_CAPTURES,
    end: `(</)(${name})(?=[\\s>])[^>]*(>)?`,
    endCaptures: TAG_CAPTURES,
    patterns: [
      ATTRIBUTE,
      {
        begin: '(>)',
        beginCaptures: {1: TAG_CAPTURES[3]},
        end: `(?=</${name}(?:[\\s>]|$))`,
        contentName,
        patterns: [{include}],
      },
    ],
  };
}

// The opening tag carries `lang="x"`, `lang='x'` or `lang = x`; a TextMate lookahead reads one line only.
function langLookahead(lang: string): string {
  const value = escapeRegExp(lang);
  return `(?=[^>]*[\\s/]lang\\s*=\\s*(?:"${value}"|'${value}'|${value}(?![^\\s>])))`;
}

// Serves a pinned copy as `scope`, so it never clashes with the official extension. VS Code reads injections from
// the document's root grammar only, so its own injections move to `rootInjections`, narrowed to its block.
function serveVendored(
  copy: VendoredGrammar,
  upstream: string,
  scope: string,
  embedded: string,
  rootInjections: Record<string, TmRule>
): GrammarFile[] {
  const rename = (include: string): string =>
    include === upstream || include.startsWith(`${upstream}#`) ? scope + include.slice(upstream.length) : include;
  const {injections, ...main} = renameIncludes(readVendored(copy.dir, copy.main), rename);
  // At the root, `#x` and `$self` would name the root grammar.
  const anchor = (include: string): string => (include === '$self' ? scope : include.startsWith('#') ? scope + include : include);
  for (const [selector, rule] of Object.entries(injections ?? {})) {
    rootInjections[insideScope(selector, embedded)] = renameIncludes(rule, anchor);
  }
  const files = [grammarFile({...main, scopeName: scope})];
  for (const name of copy.injections) {
    const injection = renameIncludes(readVendored(copy.dir, name), rename);
    const injectionSelector = insideScope(injection.injectionSelector!, embedded);
    files.push(grammarFile({...injection, scopeName: `ucf.${injection.scopeName}`, injectionSelector}, [ROOT_SCOPE]));
  }
  return files;
}

/** The `.ucf` grammar first, then the pinned copies it embeds; a registry row needs no grammar edit. */
export function generateGrammar(kinds: readonly BlockKind[] = BLOCK_KINDS): GrammarFile[] {
  // An HTML comment between blocks opens nothing, as in the splitter.
  const patterns: TmRule[] = [{begin: '<!--', end: '-->', name: 'comment.block.ucf'}];
  const injections: Record<string, TmRule> = {};
  const vendored: GrammarFile[] = [];
  for (const {tag, grammar} of kinds) {
    const embedded = `meta.embedded.block.${tag}`;
    let include = grammar.scopeName;
    const copy = VENDORED[grammar.scopeName];
    if (copy) {
      include = `${ROOT_SCOPE}.${tag}`;
      vendored.push(...serveVendored(copy, grammar.scopeName, include, embedded, injections));
    }
    // A `lang` rule comes first: at the same `<tag`, the first listed pattern wins.
    for (const [lang, scope] of Object.entries(grammar.byLang ?? {})) {
      patterns.push(blockRule(tag, `${embedded}.${scope.languageId}`, scope.scopeName, langLookahead(lang)));
    }
    patterns.push(blockRule(tag, embedded, include));
  }
  return [grammarFile({scopeName: ROOT_SCOPE, patterns, injections}), ...vendored];
}
