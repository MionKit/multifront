import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {AST} from 'svelte/compiler';
import {importPath} from '../imports/resolveTarget.ts';
import {LIBRARY_SCOPE_HELPER} from '../react/scopeHelper.ts';
import type {BuildContext, LibraryMode, StyleModule, SvelteNode} from '../types.ts';
import {walk} from './ast.ts';

const SOURCE_NODES: ReadonlySet<string> = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']);

/** `offset`: where the parsed code starts in `text`; `import()` in markup is rewritten too. */
export function shipFrontImports(text: MagicString, root: AST.Root, offset: number): void {
  walk([root.module, root.instance, root.fragment], (node) => {
    const source = (SOURCE_NODES.has(node.type) || node.type === 'ImportExpression' ? node.source : undefined) as
      | SvelteNode
      | undefined;
    const value = source?.type === 'Literal' ? source.value : undefined;
    if (typeof value !== 'string' || !/^\.\.?\//.test(value) || !value.endsWith('.front')) return;
    // The whole literal: an escaped specifier's text is not its value.
    const shipped = JSON.stringify(`${value.slice(0, -'.front'.length)}.svelte`);
    text.overwrite(offset + source!.start, offset + source!.end, shipped);
  });
}

/** The import lines of a library package's `Card.svelte`: its own CSS file, the shipped helper, inlined class maps. */
export function libraryImports(
  ctx: BuildContext & {library: LibraryMode},
  locals: Map<StyleModule, string>,
  helpers: string[]
): string[] {
  const css = `./${basename(ctx.filename, '.front')}.css`;
  const helper = importPath(ctx.filename, `${ctx.library.src}/${LIBRARY_SCOPE_HELPER}`);
  return [
    ...(ctx.styles.length > 0 ? [`import ${JSON.stringify(css)};`] : []),
    ...(helpers.length > 0 ? [`import {${helpers.join(', ')}} from ${JSON.stringify(helper)};`] : []),
    ...[...locals].map(([{classes}, local]) => `const ${local} = ${JSON.stringify(classes)};`),
  ];
}
