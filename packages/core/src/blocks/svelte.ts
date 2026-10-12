import MagicString from 'magic-string';
import type {AST, CompileError} from 'svelte/compiler';
import {freshName} from '../ast.ts';
import {DiagnosticsError, createDiagnostic, styleInsideTarget} from '../diagnostics.ts';
import {loadSvelteCompiler} from '../compilers.ts';
import {frameworkInBlock} from '../imports/rewrite.ts';
import {SCOPE_HELPER_ID} from '../react/scopeHelper.ts';
import {topLevelTags} from '../scan.ts';
import {isNode, walk} from '../svelte/ast.ts';
import type {Node} from '../svelte/ast.ts';
import {ELEMENTS, forwardScope} from '../svelte/forward.ts';
import type {Block, BlockKind, BuildContext, Diagnostic, SplitResult, StyleModule, VirtualFile} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);

const RUNES: ReadonlySet<string> = new Set(['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host']);

// Not references: a property key, an import or export name.
const NAME_KEYS: ReadonlySet<string> = new Set(['key', 'imported', 'exported', 'local']);

type Statement = AST.Script['content']['body'][number];
type Pattern = Extract<Statement, {type: 'VariableDeclaration'}>['declarations'][number]['id'];

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

// `const state = $state(0)`: a top-level name whose value is a rune call keeps `$state` a rune.
function runeDeclared(scripts: (AST.Script | null)[]): Set<string> {
  const names = new Set<string>();
  for (const script of scripts) {
    for (const node of (script?.content.body ?? []) as unknown as Node[]) {
      if (node.type !== 'VariableDeclaration') continue;
      for (const {id, init} of node.declarations as {id: Pattern; init: unknown}[]) {
        const callee = isNode(init) && init.type === 'CallExpression' ? (init.callee as Node) : undefined;
        const rune = callee?.type === 'MemberExpression' ? (callee.object as Node) : callee;
        if (rune?.type === 'Identifier' && RUNES.has((rune.name as string).slice(1))) patternNames(id, names);
      }
    }
  }
  return names;
}

// `ctx.modules` is a plain object: `$constructor` would otherwise read Object.prototype.
function ownModule(ctx: BuildContext, name: string): StyleModule | undefined {
  return Object.hasOwn(ctx.modules, name) ? ctx.modules[name] : undefined;
}

// `$style` also reads a `module="style"` block, as `$name` reads `module="name"`.
function classMap(bare: string, ctx: BuildContext): StyleModule | undefined {
  return bare === 'style' ? (ownModule(ctx, '$style') ?? ownModule(ctx, 'style')) : ownModule(ctx, bare);
}

// `shorthand`: the span of a `{$x}` key or prop, which must keep the name `$x`.
interface StyleUse {
  node: Node;
  module: StyleModule;
  shorthand?: {start: number; end: number; attribute: boolean};
}

// `names`: every identifier the block uses, so a local we add shadows none.
function styleUses(
  root: AST.Root,
  block: Block,
  ctx: BuildContext
): {missing: Diagnostic[]; uses: StyleUse[]; names: Set<string>; runes: boolean} {
  const stores = topLevelNames([root.module, root.instance]);
  const runeNames = runeDeclared([root.module, root.instance]);
  const missing: Diagnostic[] = [];
  const uses: StyleUse[] = [];
  const names = new Set<string>();
  // Svelte's own switch: `<svelte:options runes>`, else any rune reference.
  let runes = false;
  // `<Child {$style} />`: the attribute is passed on as a prop named `$style`.
  const shorthandAttributes = new Map<Node, Node>();
  const visit = (node: Node, parent: Node | undefined, key: string): void => {
    if (node.type === 'Attribute' && isNode(node.value) && node.value.type === 'ExpressionTag') {
      const expression = node.value.expression as Node;
      if (expression.type === 'Identifier' && expression.start === node.start + 1) shorthandAttributes.set(expression, node);
    }
    if (node.type !== 'Identifier') return;
    const name = node.name as string;
    names.add(name);
    const bare = name.slice(1);
    if (!name.startsWith('$') || bare === '' || bare.startsWith('$')) return;
    // `($style as X)` is a use; a TS type name or `{$x: 1}`, `o.$x` is not.
    const property = NAME_KEYS.has(key) || (key === 'property' && parent?.type === 'MemberExpression');
    if ((property && !parent?.computed) || (parent?.type.startsWith('TS') && key !== 'expression')) return;
    if (RUNES.has(bare)) {
      runes ||= !stores.has(bare) || runeNames.has(bare);
      return;
    }
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
  runes = root.options?.runes ?? runes;
  return {missing: missing.sort((first, second) => first.start - second.start), uses, names, runes};
}

// `$style` → `__ucfStyle`, `$classes` → `__ucfClasses`: Svelte reserves `$` for stores.
function localNames(uses: StyleUse[], used: Set<string>): Map<StyleModule, string> {
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

function stampScope(text: MagicString, root: AST.Root, block: Block, ctx: BuildContext): void {
  const stamp = ` data-v-${ctx.scopeId}=""`;
  walk(root.fragment, (node) => {
    // `<svelte:head>` content is the document's, not the component's.
    if (node.type === 'SvelteHead') return false;
    // Svelte allows no space after `<`: the name ends `name.length` after it.
    if (ELEMENTS.has(node.type)) text.appendLeft(block.contentStart + node.start + 1 + (node.name as string).length, stamp);
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
  const {missing, uses, names: used, runes} = styleUses(root, block, ctx);
  if (missing.length > 0) throw new DiagnosticsError(missing);

  // Over the whole .ucf source, so the map points straight into the .ucf file.
  const text = new MagicString(ctx.source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, ctx.source.length);
  const locals = localNames(uses, used);
  for (const {node, module, shorthand} of uses) {
    const local = locals.get(module)!;
    const name = node.name as string;
    const replacement = shorthand ? (shorthand.attribute ? `${name}={${local}}` : `${name}: ${local}`) : local;
    const {start, end} = shorthand ?? node;
    text.overwrite(block.contentStart + start, block.contentStart + end, replacement);
  }
  if (ctx.hasScoped) stampScope(text, root, block, ctx);
  const {helpers, lines} = forwardScope(text, root, block, ctx, used, runes);

  // JSON quoting keeps any path a valid string.
  const imports = [
    ...ctx.styles.map(({id}) => `import ${JSON.stringify(id)};`),
    ...[...locals].map(([{id}, local]) => `import ${local} from ${JSON.stringify(id)};`),
    ...(helpers.length > 0 ? [`import {${helpers.join(', ')}} from ${JSON.stringify(SCOPE_HELPER_ID)};`] : []),
  ];
  // Module script imports also reach the instance script and markup; not the reverse.
  const script = root.module ?? root.instance;
  const added: string[] = [];
  if (script) {
    // Svelte sets `start` on the script's Program (right after the opening tag); its estree type leaves it out.
    const {start} = script.content as unknown as AST.BaseNode;
    text.appendLeft(block.contentStart + start, imports.map((line) => `\n${line}`).join(''));
  } else added.push(...imports);
  if (lines.length > 0 && root.instance) {
    // After the last statement, so `$props()` is declared before the warning reads it.
    const content = root.instance.content as unknown as AST.BaseNode & {body: AST.BaseNode[]};
    const end = content.body.at(-1)?.end ?? content.start;
    text.appendLeft(block.contentStart + end, lines.map((line) => `\n${line}`).join(''));
  } else added.push(...lines);
  if (added.length > 0) text.prependRight(block.contentStart, `<script>\n${added.join('\n')}\n</script>`);
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: ctx.filename, hires: true, includeContent: true});
  return {ext: '.svelte', code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
const nests = (name: string): boolean => !VOID_ELEMENTS.has(name);

// An `import()` in markup is left to the post rewrite of the compiled module.
function check(block: Block, split: SplitResult): Diagnostic[] {
  const tags = topLevelTags(block.content, nests);
  return [...styleInsideTarget(block, split, nests), ...frameworkInBlock(block, split, tags, 'svelte')];
}

export const svelteKind: BlockKind = {
  tag: 'svelte',
  role: 'target',
  grammar: {scopeName: 'source.svelte', languageId: 'svelte'},
  check,
  build,
};
