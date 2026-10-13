import {basename, dirname, relative, sep} from 'node:path';
import type MagicString from 'magic-string';
import type {AST} from 'svelte/compiler';
import {LIBRARY_SCOPE_HELPER} from '../react/scopeHelper.ts';
import type {Block, BuildContext, LibraryMode, StyleModule, SvelteNode} from '../types.ts';
import {walk} from './ast.ts';

const SOURCE_NODES: ReadonlySet<string> = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']);

// Relative to `dir`, always starting with `.`, so a bundler never reads it as a package.
function relativeImport(dir: string, file: string): string {
  const path = relative(dir, file).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/** Each relative `.ucf` specifier of the block, `import()` in markup included, becomes the shipped `.svelte` file. */
export function shipUcfImports(text: MagicString, root: AST.Root, block: Block): void {
  walk([root.module, root.instance, root.fragment], (node) => {
    const source = (SOURCE_NODES.has(node.type) || node.type === 'ImportExpression' ? node.source : undefined) as
      | SvelteNode
      | undefined;
    const value = source?.type === 'Literal' ? source.value : undefined;
    if (typeof value !== 'string' || !/^\.\.?\//.test(value) || !value.endsWith('.ucf')) return;
    // The whole literal: an escaped specifier's text is not its value.
    const shipped = JSON.stringify(`${value.slice(0, -'.ucf'.length)}.svelte`);
    text.overwrite(block.contentStart + source!.start, block.contentStart + source!.end, shipped);
  });
}

/** The import lines of a library package's `Card.svelte`: its own CSS file, the shipped helper, inlined class maps. */
export function libraryImports(
  ctx: BuildContext & {library: LibraryMode},
  locals: Map<StyleModule, string>,
  helpers: string[]
): string[] {
  const dir = dirname(ctx.filename);
  const css = `./${basename(ctx.filename, '.ucf')}.css`;
  const helper = relativeImport(dir, `${ctx.library.src}/${LIBRARY_SCOPE_HELPER}`);
  return [
    ...(ctx.styles.length > 0 ? [`import ${JSON.stringify(css)};`] : []),
    ...(helpers.length > 0 ? [`import {${helpers.join(', ')}} from ${JSON.stringify(helper)};`] : []),
    ...[...locals].map(([{classes}, local]) => `const ${local} = ${JSON.stringify(classes)};`),
  ];
}
