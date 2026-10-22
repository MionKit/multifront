import MagicString from 'magic-string';
import {parseAst} from 'vite';
import type {Lang} from '../types.ts';

const SOURCE_NODES = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ImportExpression',
  'TSImportType',
]);

/** Rewrites each string-literal module specifier that `renamed` maps. */
export function rewriteSpecifiers(
  text: MagicString,
  code: string,
  offset: number,
  lang: Lang,
  filename: string,
  renamed: (specifier: string) => string | undefined
): void {
  let program: unknown;
  try {
    program = parseAst(code, {lang}, filename);
  } catch {
    // tsc reports the syntax error with its own position.
    return;
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type: string; value: unknown; start: number; end: number}};
    const {source} = node;
    if (
      typeof node.type === 'string' &&
      SOURCE_NODES.has(node.type) &&
      source?.type === 'Literal' &&
      typeof source.value === 'string'
    ) {
      const next = renamed(source.value);
      // The whole literal: an escaped specifier's text is not its value.
      if (next !== undefined) text.overwrite(offset + source.start, offset + source.end, JSON.stringify(next));
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(program);
}

export function frontRenamer(ext: string): (specifier: string) => string | undefined {
  return (specifier) =>
    (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.front')
      ? specifier.slice(0, -'.front'.length) + ext
      : undefined;
}

export function rewriteScript(code: string, lang: Lang, filename: string, ext: string): string {
  if (!code.includes('.front')) return code;
  const text = new MagicString(code);
  rewriteSpecifiers(text, code, 0, lang, filename, frontRenamer(ext));
  return text.toString();
}
