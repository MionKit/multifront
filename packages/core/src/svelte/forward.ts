import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {AST} from 'svelte/compiler';
import {freshName} from '../ast.ts';
import {SCOPE_ATTRS, WARN_FRAGMENT} from '../react/scopeHelper.ts';
import type {Block, BuildContext, SvelteMode, SvelteNode, SvelteRootProp} from '../types.ts';
import {isNode, patternNames} from './ast.ts';
import type {Pattern} from './ast.ts';
import {
  SVELTE_MERGE,
  handledRootProps,
  mergeRootProps,
  propsDeclaration,
  propsLine,
  rootPropsType,
  rootTakes,
  typePropsDeclaration,
} from './rootProps.ts';
import type {PropsDeclaration} from './rootProps.ts';

type Lang = 'ts' | 'js';

/** The elements and components the stamp goes on; as a root, each takes the parent's scope. */
export const ELEMENTS: ReadonlySet<string> = new Set([
  'RegularElement',
  'SvelteElement',
  'Component',
  'SvelteComponent',
  'SvelteSelf',
]);

// Render nothing in place: never a root.
const NOT_ROOTS: ReadonlySet<string> = new Set([
  'Comment',
  'SnippetBlock',
  'ConstTag',
  'DebugTag',
  'SvelteHead',
  'SvelteWindow',
  'SvelteBody',
  'SvelteDocument',
]);

// `bound`: the names an enclosing `{:then}`, `{:catch}` or boundary snippet binds around the root.
interface Roots {
  elements: {node: SvelteNode; bound: Set<string>}[];
  many: boolean;
  each: boolean;
}

function fragmentNodes(fragment: unknown): SvelteNode[] {
  return isNode(fragment) && fragment.type === 'Fragment' ? (fragment.nodes as SvelteNode[]) : [];
}

function binding(bound: Set<string>, ...patterns: unknown[]): Set<string> {
  const names = new Set(bound);
  for (const pattern of patterns) patternNames(pattern as Pattern | null, names);
  return names;
}

/** Roots are counted per branch, not across branches. */
function branchRoots(nodes: SvelteNode[], found: Roots, bound = new Set<string>()): void {
  const counted = nodes.filter(
    (node) => !NOT_ROOTS.has(node.type) && !(node.type === 'Text' && (node.data as string).trim() === '')
  );
  if (counted.length > 1) found.many = true;
  for (const node of counted) {
    if (node.type === 'IfBlock') {
      // An `{:else if}` is the one IfBlock of its `alternate`.
      branchRoots(fragmentNodes(node.consequent), found, bound);
      branchRoots(fragmentNodes(node.alternate), found, bound);
    } else if (node.type === 'KeyBlock') branchRoots(fragmentNodes(node.fragment), found, bound);
    else if (node.type === 'AwaitBlock') {
      branchRoots(fragmentNodes(node.pending), found, bound);
      branchRoots(fragmentNodes(node.then), found, binding(bound, node.value));
      branchRoots(fragmentNodes(node.catch), found, binding(bound, node.error));
    } else if (node.type === 'SvelteBoundary') {
      // Its `{#snippet failed}` and `{#snippet pending}` render in place of its children.
      const children = fragmentNodes(node.fragment);
      branchRoots(
        children.filter((child) => child.type !== 'SnippetBlock'),
        found,
        bound
      );
      for (const child of children) {
        if (child.type !== 'SnippetBlock') continue;
        branchRoots(fragmentNodes(child.body), found, binding(bound, ...(child.parameters as unknown[])));
      }
    } else if (node.type === 'EachBlock') found.each = true;
    else if (ELEMENTS.has(node.type)) found.elements.push({node, bound});
  }
}

/** Props name to spread; with no rest or props object, adds a `__ucfRest` rest or a `$props()` line typed `type`. */
function propsName(
  text: MagicString,
  declaration: PropsDeclaration | undefined,
  block: Block,
  used: Set<string>,
  lines: string[],
  type?: string,
  lang: Lang = 'js'
): string {
  const id = declaration?.declarator.id;
  if (id?.type === 'Identifier') return id.name;
  const properties = id?.type === 'ObjectPattern' ? id.properties : [];
  const rest = properties.find((property) => property.type === 'RestElement');
  if (rest?.argument.type === 'Identifier') return rest.argument.name;
  const name = freshName(used, '__ucfRest');
  used.add(name);
  if (id?.type !== 'ObjectPattern') {
    // Destructured: svelte2tsx types `let rest = $props()` with a props type it never declares.
    lines.push(propsLine(name, type, lang));
    return name;
  }
  const {start} = id as unknown as AST.BaseNode;
  const last = properties.at(-1) as unknown as AST.BaseNode | undefined;
  if (!last) text.appendLeft(block.contentStart + start + 1, `...${name}`);
  else {
    // A comma after a rest element is a syntax error: a trailing one comes before it.
    const after = last.end + /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*/.exec(block.content.slice(last.end))![0].length;
    if (block.content[after] === ',') text.appendLeft(block.contentStart + after + 1, ` ...${name}`);
    else text.appendLeft(block.contentStart + last.end, `, ...${name}`);
  }
  return name;
}

// Beside a spread, Svelte 5.57.0's SSR escapes a text attribute twice (`<b>` → `&amp;lt;b>`), an expression once.
// `on…` stays text, for Svelte's own error.
function escapeOnce(text: MagicString, node: SvelteNode, block: Block, rewritten: Set<SvelteNode>): void {
  if (node.type !== 'RegularElement' && node.type !== 'SvelteElement') return;
  for (const attribute of node.attributes as SvelteNode[]) {
    if (rewritten.has(attribute)) continue;
    const parts = attribute.type === 'Attribute' && Array.isArray(attribute.value) ? (attribute.value as SvelteNode[]) : [];
    if (parts.length === 0 || parts.some((part) => part.type !== 'Text')) continue;
    if ((attribute.name as string).startsWith('on') || !parts.some((part) => /[&<"]/.test(part.raw as string))) continue;
    const value = JSON.stringify(parts.map((part) => part.data as string).join(''));
    text.overwrite(
      block.contentStart + attribute.start,
      block.contentStart + attribute.end,
      `${attribute.name as string}={${value}}`
    );
  }
}

type Problem = [problem: string, fix?: string];

const LEGACY: Problem = ['is a legacy-mode Svelte component', 'Use $props() to make it a runes-mode component.'];

/** A helper's local, never a name the block uses; `imports` gets its import specifier. */
export function helperLocal(name: string, used: Set<string>, imports: string[]): string {
  const local = freshName(used, name);
  used.add(local);
  imports.push(local === name ? name : `${name} as ${local}`);
  return local;
}

function rootsOf(root: AST.Root): Roots {
  const found: Roots = {elements: [], many: false, each: false};
  branchRoots(root.fragment.nodes as unknown as SvelteNode[], found);
  return found;
}

// A runes-mode component with at most one root per branch: every root gets the forwarding.
const forwards = (found: Roots, mode: SvelteMode): boolean =>
  mode === 'runes' && found.elements.length > 0 && !found.many && !found.each;

/** The root props each root takes; `typed`: their type goes into the `$props()` annotation, else `type` is unset. */
function planRootProps(text: MagicString, root: AST.Root, block: Block, found: Roots, lang: Lang, typed: boolean) {
  const declaration = propsDeclaration(root.instance);
  const handled = handledRootProps(root, declaration);
  const takes = new Map(found.elements.map(({node}) => [node, rootTakes(node, handled)]));
  const type = typed ? rootPropsType(new Set([...takes.values()].flat())) : undefined;
  if (declaration && type) typePropsDeclaration(text, block, declaration, type, lang);
  return {takes, type, declaration};
}

/** The editor's half of forwarding: the build's `$props()` edits and root-prop types; returns the lines to add. */
export function typeRootProps(
  text: MagicString,
  root: AST.Root,
  block: Block,
  used: Set<string>,
  mode: SvelteMode,
  lang: Lang
): string[] {
  const found = rootsOf(root);
  if (!forwards(found, mode)) return [];
  const {type, declaration} = planRootProps(text, root, block, found, lang, true);
  const lines: string[] = [];
  propsName(text, declaration, block, used, lines, type, lang);
  return lines;
}

/** Spreads the parent's `data-v-*` props on every root, else warns in dev; `helpers`: import specifiers, `lines` end the instance script. */
export function forwardScope(
  text: MagicString,
  root: AST.Root,
  block: Block,
  ctx: BuildContext,
  used: Set<string>,
  mode: SvelteMode,
  lang: Lang
) {
  const found = rootsOf(root);
  const lines: string[] = [];
  const helpers: string[] = [];
  // An undecided block compiles either way: `$props()` would make it runes, `$$props` would break it as runes.
  if ((found.elements.length === 0 && !found.each) || mode === 'undecided') return {helpers: [], lines};
  if (forwards(found, mode)) {
    // Typed only where the `.d.ts` comes from the shipped code: an app's Svelte strips the types anyway.
    const {takes, type, declaration} = planRootProps(text, root, block, found, lang, ctx.library !== undefined);
    let props = propsName(text, declaration, block, used, lines, type, lang);
    if (found.elements.some(({bound}) => bound.has(props))) {
      // `{:then props}` around a root hides the props; a `$derived` alias reads them without Svelte's warning.
      const alias = freshName(used, '__ucfProps');
      used.add(alias);
      lines.push(`const ${alias} = $derived(${props});`);
      props = alias;
    }
    const scopeAttrs = helperLocal(SCOPE_ATTRS, used, helpers);
    const merges: Partial<Record<SvelteRootProp, string>> = {};
    const merge = (prop: SvelteRootProp): string => (merges[prop] ??= helperLocal(SVELTE_MERGE[prop], used, helpers));
    for (const {node} of found.elements) {
      // Same offset as the stamp, so the spread lands after it.
      const nameEnd = block.contentStart + node.start + 1 + (node.name as string).length;
      const {added, rewritten} = mergeRootProps(text, block, node, takes.get(node)!, props, merge);
      // A root prop it lacks rides the spread, before every author attribute: a later author spread still wins.
      const keys = added.map((prop) => `, '${prop}'`).join('');
      text.appendLeft(nameEnd, ` {...${scopeAttrs}(${props}${keys})}`);
      escapeOnce(text, node, block, rewritten);
    }
    return {helpers, lines};
  }
  if (ctx.production) return {helpers, lines};
  const name = JSON.stringify(basename(ctx.filename, '.ucf'));
  const problem: Problem =
    mode === 'legacy' ? LEGACY : found.each ? ['renders an {#each} block as its root'] : ['renders more than one root'];
  const args = problem.map((part) => JSON.stringify(part)).join(', ');
  const warn = helperLocal(WARN_FRAGMENT, used, helpers);
  if (mode === 'legacy') lines.push(`;${warn}($$props, ${name}, ${args});`);
  else {
    const props = propsName(text, propsDeclaration(root.instance), block, used, lines);
    // Called at top level, Svelte warns that the read captures only the initial props.
    lines.push(`;(() => ${warn}(${props}, ${name}, ${args}))();`);
  }
  return {helpers, lines};
}
