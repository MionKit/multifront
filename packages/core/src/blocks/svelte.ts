import type {AST, CompileError} from 'svelte/compiler';
import {DiagnosticsError, createDiagnostic, styleInsideTarget} from '../diagnostics.ts';
import {loadSvelteCompiler} from '../compilers.ts';
import type {Block, BlockKind, BuildContext, Diagnostic, VirtualFile} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);

const RUNES: ReadonlySet<string> = new Set(['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host']);

// Names that are not references: a property, an import or export name, a type.
const NAME_KEYS: ReadonlySet<string> = new Set(['key', 'imported', 'exported', 'local']);

type Node = AST.BaseNode & Record<string, unknown>;
type Statement = AST.Script['content']['body'][number];
type Pattern = Extract<Statement, {type: 'VariableDeclaration'}>['declarations'][number]['id'];

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

function patternNames(pattern: Pattern | null, names: Set<string>): void {
  if (pattern?.type === 'Identifier') names.add(pattern.name);
  else if (pattern?.type === 'ObjectPattern') {
    for (const property of pattern.properties) patternNames(property.type === 'RestElement' ? property : property.value, names);
  } else if (pattern?.type === 'ArrayPattern') for (const element of pattern.elements) patternNames(element, names);
  else if (pattern?.type === 'AssignmentPattern') patternNames(pattern.left, names);
  else if (pattern?.type === 'RestElement') patternNames(pattern.argument, names);
}

// Svelte subscribes `$x` to a store only when `x` is declared at the top level of a script.
function topLevelNames(scripts: (AST.Script | null)[]): Set<string> {
  const names = new Set<string>();
  for (const script of scripts) {
    if (!script) continue;
    for (const statement of script.content.body) {
      const node = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
      if (node.type === 'ImportDeclaration') for (const {local} of node.specifiers) names.add(local.name);
      else if (node.type === 'VariableDeclaration') for (const {id} of node.declarations) patternNames(id, names);
      else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') patternNames(node.id, names);
    }
  }
  return names;
}

function missingStyleModules(root: AST.Root, block: Block, ctx: BuildContext): Diagnostic[] {
  const stores = topLevelNames([root.module, root.instance]);
  const diagnostics: Diagnostic[] = [];
  const visit = (node: Node, parent: Node | undefined, key: string): void => {
    if (node.type !== 'Identifier') return;
    const name = node.name as string;
    const bare = name.slice(1);
    if (!name.startsWith('$') || bare === '' || bare.startsWith('$') || RUNES.has(bare)) return;
    // `($style as X)` is a use; a TS type name or `{$x: 1}`, `o.$x` is not.
    const property = NAME_KEYS.has(key) || (key === 'property' && parent?.type === 'MemberExpression');
    if ((property && !parent?.computed) || (parent?.type.startsWith('TS') && key !== 'expression')) return;
    // `$style` also reads a `module="style"` block, as `$name` reads `module="name"`.
    if (bare === 'style' ? ctx.modules.$style || ctx.modules.style : ctx.modules[bare] || stores.has(bare)) return;
    const message =
      bare === 'style'
        ? '<svelte> uses $style, but no <style module> exists; add one'
        : `<svelte> uses ${name}, but no <style module="${bare}"> or store named ${bare} exists`;
    const start = block.contentStart + node.start;
    diagnostics.push(createDiagnostic(ctx.split, 'missing-style-module', start, block.contentStart + node.end, message));
  };
  for (const part of [root.module, root.instance, root.fragment]) walk(part, visit);
  return diagnostics.sort((first, second) => first.start - second.start);
}

// The compiler rules run here, not in `check`: core checks never load a compiler.
function build(block: Block, ctx: BuildContext): VirtualFile {
  let root: AST.Root;
  try {
    root = loadSvelteCompiler(ctx.root).parse(block.content, {modern: true});
  } catch (err) {
    const {code, position, message} = (err ?? {}) as Partial<CompileError>;
    // Only Svelte's CompileError has both; anything else is a crash, not the user's syntax.
    if (typeof code !== 'string' || !position) throw err;
    // Svelte's second line is a docs URL.
    const text = `<svelte> does not parse: ${message!.split('\n')[0]}`;
    const [start, end] = position;
    throw new DiagnosticsError([
      createDiagnostic(ctx.split, 'svelte-parse-error', block.contentStart + start, block.contentStart + end, text),
    ]);
  }
  const errors = missingStyleModules(root, block, ctx);
  if (errors.length > 0) throw new DiagnosticsError(errors);
  const message = 'multifront does not build <svelte> blocks yet';
  throw new DiagnosticsError([createDiagnostic(ctx.split, 'target-not-built', block.start, block.contentStart, message)]);
}

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
export const svelteKind: BlockKind = {
  tag: 'svelte',
  role: 'target',
  grammar: {scopeName: 'source.svelte', languageId: 'svelte'},
  check: (block, split) => styleInsideTarget(block, split, (name) => !VOID_ELEMENTS.has(name)),
  build,
};
