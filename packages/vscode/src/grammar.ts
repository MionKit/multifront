import {readFileSync} from 'node:fs';
import {BLOCK_KINDS} from '@multifront/core';
import type {BlockKind, GrammarScope} from '@multifront/core';
import type {GrammarFile, TmGrammar, TmRule} from './types.ts';

export type {GrammarFile} from './types.ts';

const ROOT_SCOPE = 'source.ucf';

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
    injections: [
      'vue-directives.json',
      'vue-interpolations.json',
      'vue-sfc-script-leading-operator-fix.json',
      'vue-sfc-style-variable-injection.json',
    ],
  },
  'source.svelte': {dir: 'svelte', main: 'svelte.tmLanguage.json', injections: []},
};

const TAG_CAPTURES = {
  1: {name: 'punctuation.definition.tag.begin.ucf'},
  2: {name: 'entity.name.tag.ucf'},
  3: {name: 'punctuation.definition.tag.end.ucf'},
};

// The splitter drops an opening tag whose quote holds a `>` or runs past the line: the block never opens.
const BROKEN_QUOTE = `(?=(?:"[^"]*|'[^']*)(?:>|$))`;

const ATTRIBUTE: TmRule = {
  match: `([^\\s"'=<>/]+)(?:\\s*(=)\\s*(?:("[^">]*")|('[^'>]*')|([^\\s"'>][^\\s>]*)))?`,
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
function renameIncludes<Tree>(node: Tree, rename: (include: string) => string): Tree {
  if (Array.isArray(node)) return node.map((item: unknown) => renameIncludes(item, rename)) as Tree;
  if (node === null || typeof node !== 'object') return node;
  const entries = Object.entries(node).map(([key, value]: [string, unknown]) => [
    key,
    key === 'include' && typeof value === 'string' ? rename(value) : renameIncludes(value, rename),
  ]);
  return Object.fromEntries(entries) as Tree;
}

// Each `,` alternative of an injection selector, narrowed to inside the `embedded` block: the upstream root scope
// is never on the stack there, so where an alternative names it, the block scope takes its place.
function insideBlock(selector: string, upstream: string, embedded: string): string {
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
  const root = new RegExp(`(^|[\\s(|,])${escapeRegExp(upstream)}(?=$|[\\s)|,])`, 'g');
  return alternatives
    .map((alternative) => {
      const trimmed = alternative.trim();
      const priority = /^[LRB]:/.test(trimmed) ? trimmed.slice(0, 2) : '';
      const path = trimmed.slice(priority.length).trim();
      const replaced = path.replace(root, `$1${embedded}`);
      return replaced === path ? `${priority}${embedded} ${path}` : priority + replaced;
    })
    .join(', ');
}

function contentRule(name: string, contentName: string, include: string): TmRule {
  return {
    begin: '(>)',
    beginCaptures: {1: TAG_CAPTURES[3]},
    end: `(?=</${name}(?:[\\s>]|$))`,
    contentName,
    patterns: [{include}],
  };
}

// `lang="x"`, `lang='x'` or `lang = x`, on any line of the opening tag, picks x's grammar for the content.
function langRule(name: string, lang: string, contentName: string, include: string): TmRule {
  const value = escapeRegExp(lang);
  return {
    begin: `(?<![^\\s/])(lang)\\s*(=)\\s*(?:("${value}")|('${value}')|(${value})(?![^\\s>]))`,
    beginCaptures: ATTRIBUTE.captures!,
    end: `(?=</${name}(?:[\\s>]|$))|${BROKEN_QUOTE}`,
    patterns: [ATTRIBUTE, contentRule(name, contentName, include)],
  };
}

// The splitter's tag rules: a name ends at a space, `/` or `>`; a self-closing tag opens nothing; the first `</tag`
// then a space or `>` closes the block. Attributes may span lines; a `lang` rule is listed before ATTRIBUTE, so at
// the same `lang` it wins, and ATTRIBUTE swallows a quoted value that only contains `lang=`.
function blockRule(tag: string, embedded: string, include: string, byLang: Record<string, GrammarScope>): TmRule {
  const name = escapeRegExp(tag);
  const langs = Object.entries(byLang).map(([lang, scope]) =>
    langRule(name, lang, `${embedded}.${scope.languageId}`, scope.scopeName)
  );
  return {
    begin: `(<)(${name})(?![^\\s/>])(?![^>]*/>)`,
    beginCaptures: TAG_CAPTURES,
    end: `(</)(${name})(?=[\\s>])[^>]*(>)?|${BROKEN_QUOTE}`,
    endCaptures: TAG_CAPTURES,
    patterns: [...langs, ATTRIBUTE, contentRule(name, embedded, include)],
  };
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
  // At the root, `#x` would name the root grammar's repository.
  const anchor = (include: string): string => (include.startsWith('#') ? scope + include : include);
  for (const [selector, rule] of Object.entries(injections ?? {})) {
    rootInjections[insideBlock(selector, upstream, embedded)] = renameIncludes(rule, anchor);
  }
  const files = [grammarFile({...main, scopeName: scope})];
  for (const name of copy.injections) {
    const injection = renameIncludes(readVendored(copy.dir, name), rename);
    const injectionSelector = insideBlock(injection.injectionSelector!, upstream, embedded);
    files.push(grammarFile({...injection, scopeName: `${scope}.${injection.scopeName}`, injectionSelector}, [ROOT_SCOPE]));
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
    patterns.push(blockRule(tag, embedded, include, grammar.byLang ?? {}));
  }
  return [grammarFile({scopeName: ROOT_SCOPE, patterns, injections}), ...vendored];
}
