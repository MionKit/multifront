import {stylePreprocessOptions} from '@multifront/core';
import type {Block} from '@multifront/core';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type {Container} from 'postcss-selector-parser';
import type {EditorContext, StyleClass} from './types.ts';

type KeyKind = 'class' | 'keyframes' | 'value' | 'export';

// No braces needed there, so a selector is not always text before a `{`.
const INDENTED_LANGS = ['sass', 'styl', 'stylus'];
const KEYFRAMES = /^(-\w+-)?keyframes$/i;
const GLOBAL_NAME = /^:global\(.*\)$/;
const LOCAL_NAME = /^:local\(\s*(.*?)\s*\)$/;
// postcss-modules-values' own patterns: the colon of a definition is optional.
const VALUE_IMPORT = /^(.+?|\([\s\S]+?\))\s+from\s+("[^"]*"|'[^']*'|[\w-]+)$/;
const VALUE_DEFINITION = /(?:\s+|^)([\w-]+):?(.*?)$/;
const IMPORT_ALIAS = /^([\w-]+)(?:\s+as\s+([\w-]+))?/;
// Only a name CSS needs no escape for is written in the block as it reads.
const PLAIN_NAME = /^-?[_a-zA-Z][\w-]*$/;

/** The keys the build's CSS module exports, found synchronously; undefined when the block cannot be read. */
export function readStyleClasses(block: Block, ctx: EditorContext): StyleClass[] | undefined {
  const css = plainCss(block, ctx);
  if (css === undefined) return undefined;
  let keys: Map<string, KeyKind>;
  try {
    keys = moduleKeys(css);
  } catch {
    return undefined;
  }
  const lang = typeof block.attrs.lang === 'string' ? block.attrs.lang : 'css';
  // Every preprocessor reads `//` as a comment; plain CSS does not.
  const text = mask(block.content, stylePreprocessOptions(block).preprocessLang !== undefined);
  const preludes = INDENTED_LANGS.includes(lang) ? [{text, start: 0}] : rulePreludes(text);
  return [...keys].map(([name, kind]) => {
    const offset = nameOffset(name, kind, text, preludes);
    return offset === undefined ? {name} : {name, offset: block.contentStart + offset};
  });
}

// The block as plain CSS, preprocessed the way the build does; the sync compile refuses `modules`, so none here.
function plainCss(block: Block, {split, compiler}: EditorContext): string | undefined {
  const preprocess = stylePreprocessOptions(block);
  if (!compiler) return preprocess.preprocessLang ? undefined : block.content;
  try {
    const result = compiler.compileStyle({filename: split.filename, id: '', source: block.content, ...preprocess});
    return result.errors.length > 0 ? undefined : result.code;
  } catch {
    // A missing preprocessor throws before compileStyle can collect it.
    return undefined;
  }
}

// postcss-modules' rules: local by default, `:global` opts out; keyframes, `@value` and `:export` names are keys too.
function moduleKeys(css: string): Map<string, KeyKind> {
  const keys = new Map<string, KeyKind>();
  const add = (name: string, kind: KeyKind) => keys.has(name) || keys.set(name, kind);
  postcss.parse(css).walk((node) => {
    if (node.type === 'rule' && node.parent?.type === 'root' && node.selector === ':export') {
      node.each((child) => {
        if (child.type === 'decl') add(child.prop, 'export');
      });
    } else if (node.type === 'rule' && !insideKeyframes(node)) {
      const root = selectorParser().astSync(node.selector);
      for (const selector of root.nodes) localClasses(selector, true, (name) => add(name, 'class'));
    } else if (node.type === 'atrule' && KEYFRAMES.test(node.name)) {
      const name = keyframesName(node.params.trim());
      if (name) add(name, 'keyframes');
    } else if (node.type === 'atrule' && /^value$/i.test(node.name)) {
      for (const name of valueNames(node)) add(name, 'value');
    }
  });
  return keys;
}

function insideKeyframes(node: postcss.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && KEYFRAMES.test((parent as postcss.AtRule).name)) return true;
  }
  return false;
}

// A bare `:global` or `:local` switches the mode for the rest of the selector.
function localClasses(container: Container, local: boolean, found: (name: string) => void): void {
  let mode = local;
  for (const node of container.nodes) {
    if (node.type === 'pseudo' && (node.value === ':global' || node.value === ':local')) {
      const isLocal = node.value === ':local';
      if (node.nodes.length === 0) mode = isLocal;
      for (const selector of node.nodes) localClasses(selector, isLocal, found);
    } else if (node.type === 'class') {
      if (mode) found(node.value);
    } else if (node.type === 'pseudo') {
      for (const selector of node.nodes) localClasses(selector, mode, found);
    }
  }
}

function keyframesName(params: string): string | undefined {
  if (GLOBAL_NAME.test(params)) return undefined;
  return LOCAL_NAME.exec(params)?.[1] ?? params;
}

// `@value name: x;`, `@value name x;` or `@value (a, b as c) from './x.css';`
function valueNames({params, raws}: postcss.AtRule): string[] {
  const imported = VALUE_IMPORT.exec(params);
  if (imported) {
    const aliases = imported[1]!.replace(/^\(\s*([\s\S]+)\s*\)$/, '$1').split(/\s*,\s*/);
    return aliases.flatMap((alias) => {
      const tokens = IMPORT_ALIAS.exec(alias);
      return tokens ? [tokens[2] ?? tokens[1]!] : [];
    });
  }
  const definition = VALUE_DEFINITION.exec(`${params}${raws.between ?? ''}`);
  // A definition with no value defines nothing.
  return definition && definition[2]!.replace(/\/\*((?!\*\/).*?)\*\//g, '').length > 0 ? [definition[1]!] : [];
}

// Comments, strings and `url(...)` become spaces, so offsets stay put and nothing in them is found.
function mask(text: string, lineComments: boolean): string {
  const out = text.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    let end = i;
    if (text.startsWith('/*', i)) end = closeAt(text, '*/', i + 2);
    else if (lineComments && text.startsWith('//', i)) end = text.includes('\n', i) ? text.indexOf('\n', i) : text.length;
    else if (char === '"' || char === "'") end = stringEnd(text, i);
    else if (/^url\(/i.test(text.slice(i, i + 4))) end = closeAt(text, ')', i + 4);
    if (end > i) {
      blank(i, end);
      i = end;
    } else i++;
  }
  return out.join('');
}

function closeAt(text: string, close: string, from: number): number {
  const at = text.indexOf(close, from);
  return at === -1 ? text.length : at + close.length;
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start] || text[i] === '\n') return i + 1;
  }
  return text.length;
}

// Text that ends in `{`: a selector or an at-rule prelude, never a declaration value.
function rulePreludes(text: string): {text: string; start: number}[] {
  return [...text.matchAll(/[^{};]*\{/g)].map((match) => ({text: match[0], start: match.index}));
}

function nameOffset(name: string, kind: KeyKind, text: string, preludes: {text: string; start: number}[]): number | undefined {
  if (!PLAIN_NAME.test(name)) return undefined;
  if (kind === 'class') {
    // An escaped `\.`, or a `\` after the name, belongs to another, escaped class name.
    const pattern = new RegExp(`(?<!\\\\)\\.${name}(?![\\w\\\\-])`);
    for (const prelude of preludes) {
      const match = pattern.exec(prelude.text);
      if (match) return prelude.start + match.index + 1;
    }
    return undefined;
  }
  if (kind === 'keyframes')
    return groupOffset(new RegExp(`@(?:-\\w+-)?keyframes\\s+(?::local\\(\\s*)?(${name})(?![\\w-])`, 'di'), text);
  if (kind === 'export') return groupOffset(new RegExp(`:export\\s*\\{[^}]*?(?<![\\w-])(${name})\\s*:`, 'd'), text);
  // A value's own name: the first word of a definition, or an alias before ` from`.
  const value = `@value\\s+(?:(${name})(?![\\w-])|[^;]*?(?<![\\w-])(${name})(?![\\w-])[^;]*\\sfrom\\s)`;
  return groupOffset(new RegExp(value, 'di'), text);
}

function groupOffset(pattern: RegExp, text: string): number | undefined {
  return pattern.exec(text)?.indices?.slice(1).find(Boolean)?.[0];
}
