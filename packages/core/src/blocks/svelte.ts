import MagicString from 'magic-string';
import type {AST, CompileError} from 'svelte/compiler';
import {freshName} from '../ast.ts';
import {DiagnosticsError, createDiagnostic, styleInsideTarget} from '../diagnostics.ts';
import {loadSvelteCompiler} from '../compilers.ts';
import type {Block, BlockKind, BuildContext, Diagnostic, StyleModule, VirtualFile} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);

const RUNES: ReadonlySet<string> = new Set(['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host']);

// Not references: a property key, an import or export name.
const NAME_KEYS: ReadonlySet<string> = new Set(['key', 'imported', 'exported', 'local']);

type Node = AST.BaseNode & Record<string, unknown>;
type Statement = AST.Script['content']['body'][number];
type Pattern = Extract<Statement, {type: 'VariableDeclaration'}>['declarations'][number]['id'];

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

// `visit` returning false skips the node's children.
type Visit = (node: Node, parent: Node | undefined, key: string) => boolean | void;

function walk(value: unknown, visit: Visit, parent?: Node, key = ''): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, parent, key);
    return;
  }
  if (!isNode(value)) return;
  if (visit(value, parent, key) === false) return;
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

// Own keys only: `ctx.modules` is a plain object, so `$constructor` would read Object.prototype.
function ownModule(ctx: BuildContext, name: string): StyleModule | undefined {
  return Object.hasOwn(ctx.modules, name) ? ctx.modules[name] : undefined;
}

// `$style` also reads a `module="style"` block, as `$name` reads `module="name"`.
function classMap(bare: string, ctx: BuildContext): StyleModule | undefined {
  return bare === 'style' ? (ownModule(ctx, '$style') ?? ownModule(ctx, 'style')) : ownModule(ctx, bare);
}

// A `$x` use of a class map; `shorthand` holds the span that must keep the name `$x` (`{$x}` as a key or a prop).
interface StyleUse {
  node: Node;
  module: StyleModule;
  shorthand?: {start: number; end: number; attribute: boolean};
}

function styleUses(root: AST.Root, block: Block, ctx: BuildContext): {missing: Diagnostic[]; uses: StyleUse[]} {
  const stores = topLevelNames([root.module, root.instance]);
  const missing: Diagnostic[] = [];
  const uses: StyleUse[] = [];
  // `<Child {$style} />`: the attribute is passed on as a prop named `$style`.
  const shorthandAttributes = new Map<unknown, Node>();
  const visit = (node: Node, parent: Node | undefined, key: string): void => {
    if (node.type === 'Attribute' && isNode(node.value) && node.value.type === 'ExpressionTag') {
      const expression = node.value.expression as Node;
      if (expression.type === 'Identifier' && expression.start === node.start + 1) shorthandAttributes.set(expression, node);
    }
    if (node.type !== 'Identifier') return;
    const name = node.name as string;
    const bare = name.slice(1);
    if (!name.startsWith('$') || bare === '' || bare.startsWith('$') || RUNES.has(bare)) return;
    // `($style as X)` is a use; a TS type name or `{$x: 1}`, `o.$x` is not.
    const property = NAME_KEYS.has(key) || (key === 'property' && parent?.type === 'MemberExpression');
    if ((property && !parent?.computed) || (parent?.type.startsWith('TS') && key !== 'expression')) return;
    const module = classMap(bare, ctx);
    if (module) {
      const attribute = shorthandAttributes.get(node);
      const shorthand = attribute
        ? {start: attribute.start, end: attribute.end, attribute: true}
        : key === 'value' && parent?.type === 'Property' && parent.shorthand
          ? {start: node.start, end: node.end, attribute: false}
          : undefined;
      uses.push({node, module, shorthand});
      return;
    }
    if (bare !== 'style' && stores.has(bare)) return;
    const message =
      bare === 'style'
        ? '<svelte> uses $style, but no <style module> exists; add one'
        : `<svelte> uses ${name}, but no <style module="${bare}"> or store named ${bare} exists`;
    const start = block.contentStart + node.start;
    missing.push(createDiagnostic(ctx.split, 'missing-style-module', start, block.contentStart + node.end, message));
  };
  for (const part of [root.module, root.instance, root.fragment]) walk(part, visit);
  return {missing: missing.sort((first, second) => first.start - second.start), uses};
}

function identifierNames(root: AST.Root): Set<string> {
  const names = new Set<string>();
  for (const part of [root.module, root.instance, root.fragment]) {
    walk(part, (node) => {
      if (node.type === 'Identifier') names.add(node.name as string);
    });
  }
  return names;
}

// `$style` → `__ucfStyle`, `$classes` → `__ucfClasses`: Svelte reserves `$` for stores.
function localNames(uses: StyleUse[], root: AST.Root): Map<StyleModule, string> {
  const used = identifierNames(root);
  const locals = new Map<StyleModule, string>();
  for (const {node, module} of uses) {
    if (locals.has(module)) continue;
    const bare = (node.name as string).slice(1);
    const local = freshName(used, `__ucf${bare[0]!.toUpperCase()}${bare.slice(1)}`);
    used.add(local);
    locals.set(module, local);
  }
  return locals;
}

// Host and component elements; what `<svelte:head>` holds belongs to the document, not to the component.
const STAMPED: ReadonlySet<string> = new Set(['RegularElement', 'SvelteElement', 'Component', 'SvelteComponent', 'SvelteSelf']);

function stampScope(text: MagicString, root: AST.Root, block: Block, ctx: BuildContext): void {
  const stamp = ` data-v-${ctx.scopeId}=""`;
  walk(root.fragment, (node) => {
    if (node.type === 'SvelteHead') return false;
    // Svelte allows no space after `<`: the name ends `name.length` after it.
    if (STAMPED.has(node.type)) text.appendLeft(block.contentStart + node.start + 1 + (node.name as string).length, stamp);
    return undefined;
  });
}

function parseBlock(block: Block, ctx: BuildContext): AST.Root {
  try {
    return loadSvelteCompiler(ctx.root).parse(block.content, {modern: true});
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
}

// The compiler rules run here, not in `check`: core checks never load a compiler.
function build(block: Block, ctx: BuildContext): VirtualFile {
  const root = parseBlock(block, ctx);
  const {missing, uses} = styleUses(root, block, ctx);
  if (missing.length > 0) throw new DiagnosticsError(missing);

  // MagicString over the whole .ucf source, so the map points straight into the .ucf file.
  const text = new MagicString(ctx.source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, ctx.source.length);
  const locals = localNames(uses, root);
  for (const {node, module, shorthand} of uses) {
    const local = locals.get(module)!;
    const name = node.name as string;
    const replacement = shorthand ? (shorthand.attribute ? `${name}={${local}}` : `${name}: ${local}`) : local;
    const {start, end} = shorthand ?? node;
    text.overwrite(block.contentStart + start, block.contentStart + end, replacement);
  }
  if (ctx.hasScoped) stampScope(text, root, block, ctx);

  // JSON quoting keeps any path a valid string.
  const imports = [
    ...ctx.styles.map(({id}) => `import ${JSON.stringify(id)};`),
    ...[...locals].map(([{id}, local]) => `import ${local} from ${JSON.stringify(id)};`),
  ];
  // The module script's imports reach the instance script and the markup too; the reverse does not hold.
  const script = root.module ?? root.instance;
  if (imports.length > 0 && script) {
    // Svelte sets `start` on the script's Program (right after the opening tag); its estree type leaves it out.
    const {start} = script.content as unknown as AST.BaseNode;
    text.appendLeft(block.contentStart + start, imports.map((line) => `\n${line}`).join(''));
  } else if (imports.length > 0) {
    text.prependRight(block.contentStart, `<script>\n${imports.join('\n')}\n</script>`);
  }
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: ctx.filename, hires: true, includeContent: true});
  return {ext: '.svelte', code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
export const svelteKind: BlockKind = {
  tag: 'svelte',
  role: 'target',
  grammar: {scopeName: 'source.svelte', languageId: 'svelte'},
  check: (block, split) => styleInsideTarget(block, split, (name) => !VOID_ELEMENTS.has(name)),
  build,
};
