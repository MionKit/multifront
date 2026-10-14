import MagicString from 'magic-string';
import type {AST, CompileError} from 'svelte/compiler';
import {freshName} from '../ast.ts';
import {DiagnosticsError, createDiagnostic, styleInsideTarget} from '../diagnostics.ts';
import {loadSvelteCompiler} from '../compilers.ts';
import {frameworkInBlock} from '../imports/rewrite.ts';
import {SCOPE_HELPER_ID} from '../react/scopeHelper.ts';
import {topLevelTags} from '../scan.ts';
import {isNode, patternNames, walk} from '../svelte/ast.ts';
import {ELEMENTS, forwardScope, typeRootProps} from '../svelte/forward.ts';
import {libraryImports, shipUcfImports} from '../svelte/library.ts';
import type {
  Block,
  BlockKind,
  BuildContext,
  Diagnostic,
  SplitResult,
  SvelteCompiler,
  SvelteMode,
  SvelteNode,
  SvelteEditorSource,
  SvelteScriptLang,
  VirtualFile,
} from '../types.ts';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);

// Svelte compiles only a root `<style>`; one inside an element (`<svelte:head>`) is valid markup.
const nests = (name: string): boolean => !VOID_ELEMENTS.has(name);

const RUNES: ReadonlySet<string> = new Set(['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host']);

// Not references: a property key, an import or export name.
const NAME_KEYS: ReadonlySet<string> = new Set(['key', 'imported', 'exported', 'local']);

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

// Top-level names that keep `$name` a rune: `const state = $state(0)`, and svelte/store's `derived` (Svelte's rule).
function runeDeclared(scripts: (AST.Script | null)[]): Set<string> {
  const names = new Set<string>();
  for (const script of scripts) {
    for (const node of script?.content.body ?? []) {
      if (node.type === 'ImportDeclaration' && node.source.value === 'svelte/store')
        for (const {local} of node.specifiers) if (local.name === 'derived') names.add('derived');
      if (node.type !== 'VariableDeclaration') continue;
      for (const {id, init} of node.declarations) {
        const callee = init?.type === 'CallExpression' ? init.callee : undefined;
        const rune = callee?.type === 'MemberExpression' ? callee.object : callee;
        if (rune?.type === 'Identifier' && rune.name.startsWith('$') && RUNES.has(rune.name.slice(1))) patternNames(id, names);
      }
    }
  }
  return names;
}

// Svelte's legacy-only syntax at the top of the instance script: `$:` and `export let`.
function legacyScript(instance: AST.Script | null): boolean {
  const body = instance?.content.body ?? [];
  const lets = new Set<string>();
  for (const node of body)
    if (node.type === 'VariableDeclaration' && node.kind === 'let') for (const {id} of node.declarations) patternNames(id, lets);
  return body.some(
    (node) =>
      node.type === 'LabeledStatement' ||
      (node.type === 'ExportNamedDeclaration' &&
        ((node.declaration?.type === 'VariableDeclaration' && node.declaration.kind === 'let') ||
          node.specifiers.some(({local}) => local.type === 'Identifier' && lets.has(local.name))))
  );
}

// `modules` is a plain object: `$constructor` would otherwise read Object.prototype.
function ownModule<Module>(modules: Record<string, Module>, name: string): Module | undefined {
  return Object.hasOwn(modules, name) ? modules[name] : undefined;
}

// `$style` also reads a `module="style"` block, as `$name` reads `module="name"`.
function classMap<Module>(bare: string, modules: Record<string, Module>): Module | undefined {
  return bare === 'style' ? (ownModule(modules, '$style') ?? ownModule(modules, 'style')) : ownModule(modules, bare);
}

// Offsets in the block content.
type Span = Pick<AST.BaseNode, 'start' | 'end'>;

// `shorthand`: a `{$x}` prop or object key, which must keep the name `$x`.
interface StyleUse<Module> {
  node: SvelteNode;
  module: Module;
  shorthand?: 'attribute' | 'property';
}

// `names`: every identifier the block uses, so a local we add shadows none.
function styleUses<Module>(
  root: AST.Root,
  block: Block,
  split: SplitResult,
  modules: Record<string, Module>
): {missing: Diagnostic[]; uses: StyleUse<Module>[]; names: Set<string>; mode: SvelteMode; unreadable: Span[]} {
  const stores = topLevelNames([root.module, root.instance]);
  const runeNames = runeDeclared([root.module, root.instance]);
  const missing: Diagnostic[] = [];
  const uses: StyleUse<Module>[] = [];
  const names = new Set<string>();
  const unreadable: Span[] = [];
  // Svelte's own switch: `<svelte:options runes>`, else any rune reference; legacy on `$$props` or `$$restProps`.
  let runes = false;
  let legacy = legacyScript(root.instance);
  // `<Child {$style} />`: the attribute is passed on as a prop named `$style`.
  const shorthandAttributes = new Set<SvelteNode>();
  const visit = (node: SvelteNode, parent: SvelteNode | undefined, key: string): void => {
    if (node.type === 'Attribute' && isNode(node.value) && node.value.type === 'ExpressionTag') {
      const expression = node.value.expression as SvelteNode;
      if (expression.type === 'Identifier' && expression.start === node.start + 1) shorthandAttributes.add(expression);
    }
    if (node.type !== 'Identifier') return;
    const name = node.name as string;
    // The loose parser's stand-in for an expression it cannot read spans that whole text.
    if (name === '') unreadable.push({start: node.start, end: node.end});
    names.add(name);
    const bare = name.slice(1);
    if (!name.startsWith('$') || bare === '') return;
    // `($style as X)` is a use; a TS type name or `{$x: 1}`, `o.$x` is not.
    const property = NAME_KEYS.has(key) || (key === 'property' && parent?.type === 'MemberExpression');
    if ((property && !parent?.computed) || (parent?.type.startsWith('TS') && key !== 'expression')) return;
    legacy ||= name === '$$props' || name === '$$restProps';
    if (bare.startsWith('$')) return;
    if (RUNES.has(bare)) {
      runes ||= !stores.has(bare) || runeNames.has(bare);
      return;
    }
    const module = classMap(bare, modules);
    if (module) {
      const shorthand = shorthandAttributes.has(node)
        ? 'attribute'
        : key === 'value' && parent?.type === 'Property' && parent.shorthand
          ? 'property'
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
    missing.push(createDiagnostic(split, 'missing-style-module', start, block.contentStart + node.end, message));
  };
  for (const part of [root.module, root.instance, root.fragment]) walk(part, visit);
  const runesOption = root.options?.runes;
  const mode = (runesOption ?? runes) ? 'runes' : runesOption === false || legacy ? 'legacy' : 'undecided';
  return {missing: missing.sort((first, second) => first.start - second.start), uses, names, mode, unreadable};
}

// Text Svelte cannot read (`{$style.}` mid-typing): every `$name` token naming a class map, read as a plain use.
function lexicalUses<Module>(block: Block, spans: Span[], modules: Record<string, Module>): StyleUse<Module>[] {
  const uses: StyleUse<Module>[] = [];
  for (const {start, end} of spans) {
    for (const match of block.content.slice(start, end).matchAll(/(?<![\w$.])\$([A-Za-z_][\w$]*)/g)) {
      const module = classMap(match[1]!, modules);
      const at = start + match.index;
      if (module) uses.push({node: {type: 'Identifier', name: match[0], start: at, end: at + match[0].length}, module});
    }
  }
  return uses;
}

// `$style` → `__ucfStyle`, `$classes` → `__ucfClasses`: Svelte reserves `$` for stores.
function localNames<Module>(uses: StyleUse<Module>[], used: Set<string>): Map<Module, string> {
  const locals = new Map<Module, string>();
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

// Only Svelte's CompileError has both; anything else is a crash, not the user's syntax.
function isCompileError(err: unknown): err is CompileError {
  const {code, position} = (err ?? {}) as Partial<CompileError>;
  return typeof code === 'string' && !!position;
}

function parseBlock(block: Block, ctx: BuildContext): AST.Root {
  try {
    return loadSvelteCompiler(ctx.root).parse(block.content, {modern: true});
  } catch (err) {
    if (!isCompileError(err)) throw err;
    // Svelte's second line is a docs URL.
    const text = `<svelte> does not parse: ${err.message.split('\n')[0]}`;
    const [start, end] = err.position!;
    throw new DiagnosticsError([
      createDiagnostic(ctx.split, 'svelte-parse-error', block.contentStart + start, block.contentStart + end, text),
    ]);
  }
}

// Over the whole .ucf source, so the map points straight into the .ucf file.
function renameUses<Module>(
  split: SplitResult,
  block: Block,
  uses: StyleUse<Module>[],
  used: Set<string>
): {text: MagicString; locals: Map<Module, string>} {
  const text = new MagicString(split.source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, split.source.length);
  const locals = localNames(uses, used);
  for (const {node, module, shorthand} of uses) {
    const name = node.name as string;
    const start = block.contentStart + node.start;
    // The local alone overwrites `$name`, so the map takes it to `$name`.
    text.overwrite(start, block.contentStart + node.end, locals.get(module)!);
    // An attribute shorthand's `{` sits right before `$name`.
    if (shorthand === 'attribute') text.overwrite(start - 1, start, `${name}={`);
    else if (shorthand === 'property') text.appendLeft(start, `${name}: `);
  }
  return {text, locals};
}

// Svelte reads every script in the first `lang` it finds, and only `ts` as TypeScript.
function scriptLang(block: Block): SvelteScriptLang | undefined {
  const lang = topLevelTags(block.content, nests).find(({name, attrs}) => name === 'script' && attrs.lang)?.attrs.lang;
  return lang === undefined ? undefined : lang === 'ts' ? 'ts' : 'js';
}

// After the instance script's last statement, so `$props()` is declared before a warning reads it.
function addLines(text: MagicString, root: AST.Root, block: Block, lines: string[], tag: string): void {
  if (lines.length === 0) return;
  if (!root.instance) {
    text.prependRight(block.contentStart, `${tag}\n${lines.join('\n')}\n</script>`);
    return;
  }
  const content = root.instance.content as unknown as AST.BaseNode & {body: AST.BaseNode[]};
  const end = content.body.at(-1)?.end ?? content.start;
  text.appendLeft(block.contentStart + end, lines.map((line) => `\n${line}`).join(''));
}

// The compiler rules run here, not in `check`: core checks never load a compiler.
function build(block: Block, ctx: BuildContext): VirtualFile {
  const root = parseBlock(block, ctx);
  const {missing, uses, names: used, mode} = styleUses(root, block, ctx.split, ctx.modules);
  if (missing.length > 0) throw new DiagnosticsError(missing);

  const {text, locals} = renameUses(ctx.split, block, uses, used);
  if (ctx.hasScoped) stampScope(text, root, block, ctx);
  const {library} = ctx;
  // A script the build adds is `<script lang="ts">` in a library.
  const lang = scriptLang(block) ?? (library && !root.instance ? 'ts' : 'js');
  const {helpers, lines} = forwardScope(text, root, block, ctx, used, mode, lang);

  if (library) shipUcfImports(text, root, block.contentStart);
  // JSON quoting keeps any path a valid string.
  const imports = library
    ? libraryImports({...ctx, library}, locals, helpers)
    : [
        ...ctx.styles.map(({id}) => `import ${JSON.stringify(id)};`),
        ...[...locals].map(([{id}, local]) => `import ${local} from ${JSON.stringify(id)};`),
        ...(helpers.length > 0 ? [`import {${helpers.join(', ')}} from ${JSON.stringify(SCOPE_HELPER_ID)};`] : []),
      ];
  // Module script imports also reach the instance script and markup; not the reverse.
  const script = root.module ?? root.instance;
  if (script) {
    // Svelte sets `start` on the script's Program (right after the opening tag); its estree type leaves it out.
    const {start} = script.content as unknown as AST.BaseNode;
    text.appendLeft(block.contentStart + start, imports.map((line) => `\n${line}`).join(''));
  }
  // svelte2tsx types a script-less JS component with an unimported `SvelteComponent`: the package `.d.ts` breaks.
  addLines(text, root, block, script ? lines : [...imports, ...lines], library ? '<script lang="ts">' : '<script>');
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: ctx.filename, hires: true, includeContent: true});
  return {ext: '.svelte', code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}

/** The block the editor types: `build()`'s rename, `$props()` edits and root-prop types; syntax errors never throw. */
export function svelteEditorSource<Module>(
  block: Block,
  split: SplitResult,
  compiler: SvelteCompiler,
  modules: Record<string, Module>
): SvelteEditorSource<Module> {
  let root: AST.Root | undefined;
  try {
    // Loose, as Svelte's own editor parses a block mid-edit.
    root = compiler.parse(block.content, {modern: true, loose: true});
  } catch (err) {
    if (!isCompileError(err)) throw err;
  }
  const {uses, names, unreadable, mode} = root
    ? styleUses(root, block, split, modules)
    : {
        uses: [] as StyleUse<Module>[],
        names: new Set<string>(),
        unreadable: [{start: 0, end: block.content.length}],
        mode: 'undecided' as const,
      };
  uses.push(...lexicalUses(block, unreadable, modules));
  const {text, locals} = renameUses(split, block, uses, names);
  // A script added here is TypeScript, as a library's is: the editor types what the library's `.d.ts` does.
  const own = scriptLang(block);
  const lines = root ? typeRootProps(text, root, block, names, mode, own ?? (root.instance ? 'js' : 'ts')) : [];
  if (root) addLines(text, root, block, lines, '<script lang="ts">');
  const lang = own ?? (lines.length > 0 && !root?.instance ? 'ts' : 'js');
  const {mappings} = text.generateMap({source: split.filename, hires: true});
  return {code: text.toString(), locals, lang, mappings};
}

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
