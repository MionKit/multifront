import {DiagnosticsError, createDiagnostic, styleInsideTarget, targetNotBuilt} from '../diagnostics.ts';
import {loadSvelteCompiler} from '../svelteCompiler.ts';
import type {Block, BlockKind, BuildContext, Diagnostic, VirtualFile} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);

const RUNES: ReadonlySet<string> = new Set(['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host']);

// Svelte's AST and the ESTree nodes in it, read only by shape.
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

function walk(value: unknown, visit: (node: Node, parent: Node | undefined, key: string) => void, parent?: Node, key = ''): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, parent, key);
    return;
  }
  if (!isNode(value)) return;
  visit(value, parent, key);
  for (const [childKey, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null) walk(child, visit, value, childKey);
  }
}

function patternNames(pattern: unknown, names: Set<string>): void {
  if (!isNode(pattern)) return;
  if (pattern.type === 'Identifier') names.add(pattern.name as string);
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties as Node[])
      patternNames(property.type === 'RestElement' ? property.argument : property.value, names);
  } else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements as unknown[]) patternNames(element, names);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, names);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, names);
}

// Svelte subscribes `$x` to a store only when `x` is declared at the top level of a script.
function topLevelNames(scripts: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const script of scripts) {
    if (!isNode(script)) continue;
    for (const statement of (script.content as Node).body as Node[]) {
      const node =
        statement.type === 'ExportNamedDeclaration' && isNode(statement.declaration) ? statement.declaration : statement;
      if (node.type === 'ImportDeclaration') for (const spec of node.specifiers as Node[]) patternNames(spec.local, names);
      else if (node.type === 'VariableDeclaration') for (const {id} of node.declarations as Node[]) patternNames(id, names);
      else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') patternNames(node.id, names);
    }
  }
  return names;
}

function missingStyleModules(root: Node, block: Block, ctx: BuildContext): Diagnostic[] {
  const stores = topLevelNames([root.module, root.instance]);
  const diagnostics: Diagnostic[] = [];
  const visit = (node: Node, parent: Node | undefined, key: string): void => {
    if (node.type !== 'Identifier') return;
    const name = node.name as string;
    const bare = name.slice(1);
    if (!name.startsWith('$') || bare === '' || bare.startsWith('$') || RUNES.has(bare)) return;
    // A property name, not a reference: `{$theme: 1}`, `o.$theme`.
    if ((key === 'key' || (key === 'property' && parent?.type === 'MemberExpression')) && !parent?.computed) return;
    let message: string;
    if (bare === 'style') {
      if (ctx.modules.$style) return;
      message = '<svelte> uses $style, but no <style module> exists; add one';
    } else {
      if (ctx.modules[bare] || stores.has(bare)) return;
      message = `<svelte> uses ${name}, but no <style module="${bare}"> or store named ${bare} exists`;
    }
    const start = block.contentStart + node.start;
    diagnostics.push(createDiagnostic(ctx.split, 'missing-style-module', start, block.contentStart + node.end, message));
  };
  for (const part of [root.module, root.instance, root.fragment]) walk(part, visit);
  return diagnostics.sort((first, second) => first.start - second.start);
}

function parseError(err: unknown, block: Block, ctx: BuildContext): Diagnostic {
  const {code, position, message} = (err ?? {}) as {code?: unknown; position?: [number, number]; message?: string};
  // Only Svelte's CompileError has both; anything else is a crash, not the user's syntax.
  if (typeof code !== 'string' || !position) throw err;
  const [start, end] = position.map((offset) => block.contentStart + offset) as [number, number];
  // Svelte's second line is a docs URL.
  const text = `<svelte> does not parse: ${message!.split('\n')[0]}`;
  return createDiagnostic(ctx.split, 'svelte-parse-error', start, end, text);
}

// The compiler rules run here, not in `check`: core checks never load a compiler.
function build(block: Block, ctx: BuildContext): VirtualFile {
  let root: Node;
  try {
    root = loadSvelteCompiler(ctx.root).parse(block.content, {modern: true}) as unknown as Node;
  } catch (err) {
    throw new DiagnosticsError([parseError(err, block, ctx)]);
  }
  const errors = missingStyleModules(root, block, ctx);
  throw new DiagnosticsError(errors.length > 0 ? errors : [targetNotBuilt(ctx.split, block)]);
}

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
export const svelteKind: BlockKind = {
  tag: 'svelte',
  role: 'target',
  grammar: {scopeName: 'source.svelte', languageId: 'svelte'},
  check: (block, split) => styleInsideTarget(block, split, (name) => !VOID_ELEMENTS.has(name)),
  build,
};
