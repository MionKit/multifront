import {extname} from 'node:path';
import MagicString from 'magic-string';
import {Visitor, parseSync} from 'oxc-parser';
import type {
  ExportAllDeclaration,
  ExportNamedDeclaration,
  Expression,
  ImportAttribute,
  ImportDeclaration,
  ImportExpression,
  ObjectExpression,
  ObjectProperty,
  ParserOptions,
  Span,
} from 'oxc-parser';
import {createDiagnostic} from '../diagnostics.ts';
import type {Diagnostic, SourceMap, UcfImport} from '../types.ts';

type Lang = Exclude<NonNullable<ParserOptions['lang']>, 'dts'>;
type PlainObject = Omit<ObjectExpression, 'properties'> & {properties: ObjectProperty[]};

const LANGS: Record<string, Lang> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.tsx': 'tsx',
};
const VALUE_NOT_LITERAL = "the framework attribute must be a string literal: with {framework: 'react'} (or vue, svelte)";
const OPTIONS_NOT_LITERAL =
  'import() options of a .ucf import must be an object literal, so multifront can read its framework attribute';

/** A `lang.<ext>` query looks like `C.vue?vue&type=script&lang.ts`; `.ts`, `.mts`, `.cts` fall through to ts. */
function langOf(filename: string): Lang {
  const queryAt = filename.indexOf('?');
  const path = queryAt < 0 ? filename : filename.slice(0, queryAt);
  const fromPath = LANGS[extname(path)];
  if (fromPath) return fromPath;
  const fromQuery = queryAt < 0 ? undefined : /[?&]lang\.(\w+)/.exec(filename.slice(queryAt));
  return (fromQuery && LANGS[`.${fromQuery[1]}`]) ?? 'ts';
}

/** The TS plugin reads a template literal without expressions as a string too. */
export function literalValue(node: Expression): string | undefined {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
}

export function keyName(key: ObjectProperty['key'] | ImportAttribute['key']): string | undefined {
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

// A spread or computed key could hold the framework, unreadable statically.
function isPlainObject(node: Expression): node is PlainObject {
  return node.type === 'ObjectExpression' && node.properties.every((prop) => prop.type === 'Property' && !prop.computed);
}

/** Rewrites `.ucf` imports so `with { framework }` becomes `?framework=<value>` on the specifier (spec 4.4). */
export function rewriteImportAttributes(
  code: string,
  filename: string
): {code: string; map: SourceMap | null; imports: UcfImport[]; errors: Diagnostic[]} {
  const imports: UcfImport[] = [];
  const errors: Diagnostic[] = [];
  const unchanged = {code, map: null, imports, errors};
  if (!code.includes('.ucf')) return unchanged;
  const {program, comments, errors: parseErrors} = parseSync(filename, code, {lang: langOf(filename), sourceType: 'module'});
  // The importer's own compiler reports its syntax errors.
  if (parseErrors.length) return unchanged;

  const text = new MagicString(code);
  const commentEnds = new Map(comments.map((comment) => [comment.start, comment.end]));
  const nextToken = (from: number): number => {
    let at = from;
    while (at < code.length) {
      if (/\s/.test(code[at]!)) at++;
      else if (commentEnds.has(at)) at = commentEnds.get(at)!;
      else break;
    }
    return at;
  };
  const fail = (node: Span, message: string) =>
    errors.push(createDiagnostic({filename, source: code}, 'framework-attribute-not-literal', node.start, node.end, message));
  // The caller removes the whole list instead when `index` is its only item.
  const removeItem = (items: Span[], index: number) => {
    const next = items[index + 1];
    if (next) text.remove(items[index]!.start, next.start);
    else text.remove(items[index - 1]!.end, items[index]!.end);
  };
  const found = (kind: UcfImport['kind'], source: Expression): UcfImport | undefined => {
    const specifier = literalValue(source);
    if (!specifier?.endsWith('.ucf')) return undefined;
    const entry: UcfImport = {kind, specifier, start: source.start, end: source.end};
    imports.push(entry);
    return entry;
  };
  const moveIntoSpecifier = (entry: UcfImport, framework: string) => {
    entry.framework = framework;
    // `'` stays as is in encodeURIComponent and would end a single-quoted specifier; a lone surrogate makes it throw.
    const value = encodeURIComponent(framework.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')).replaceAll("'", '%27');
    text.appendLeft(entry.end - 1, `?framework=${value}`);
  };

  const fromStatic = (kind: UcfImport['kind']) => (node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration) => {
    const entry = node.source && found(kind, node.source);
    if (!entry) return;
    const {attributes} = node;
    const index = attributes.findIndex((attribute) => keyName(attribute.key) === 'framework');
    if (index < 0) return;
    moveIntoSpecifier(entry, attributes[index]!.value.value);
    if (attributes.length > 1) return removeItem(attributes, index);
    let close = nextToken(attributes[0]!.end);
    if (code[close] === ',') close = nextToken(close + 1);
    text.remove(entry.end, close + 1);
  };

  const fromDynamic = (node: ImportExpression) => {
    const entry = found('dynamic', node.source);
    if (!entry || !node.options) return;
    const {options} = node;
    if (!isPlainObject(options)) return fail(options, OPTIONS_NOT_LITERAL);
    const withIndex = options.properties.findIndex((prop) => keyName(prop.key) === 'with');
    const withValue = options.properties[withIndex]?.value;
    if (!withValue) return;
    if (!isPlainObject(withValue)) return fail(withValue, OPTIONS_NOT_LITERAL);
    const attributes = withValue.properties;
    // An object literal may repeat a key; the last one wins at runtime, and none may reach it.
    const indexes = attributes.flatMap((prop, index) => (keyName(prop.key) === 'framework' ? [index] : []));
    if (!indexes.length) return;
    const notLiteral = indexes.find((index) => literalValue(attributes[index]!.value) === undefined);
    if (notLiteral !== undefined) return fail(attributes[notLiteral]!.value, VALUE_NOT_LITERAL);
    moveIntoSpecifier(entry, literalValue(attributes[indexes.at(-1)!]!.value)!);
    if (indexes.length < attributes.length) return indexes.forEach((index) => removeItem(attributes, index));
    if (options.properties.length > 1) return removeItem(options.properties, withIndex);
    // Up to the closing paren, so a trailing comma goes too.
    text.remove(entry.end, node.end - 1);
  };

  new Visitor({
    ImportDeclaration: fromStatic('static'),
    ExportNamedDeclaration: fromStatic('reexport'),
    ExportAllDeclaration: fromStatic('reexport'),
    ImportExpression: fromDynamic,
  }).visit(program);

  if (!text.hasChanged()) return unchanged;
  const map = text.generateMap({source: filename, hires: true, includeContent: true});
  const {sources, sourcesContent, names, mappings} = map;
  return {code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}, imports, errors};
}
