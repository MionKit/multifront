import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {AST} from 'svelte/compiler';
import {freshName} from '../ast.ts';
import {SCOPE_ATTRS, WARN_FRAGMENT} from '../react/scopeHelper.ts';
import type {Block, BuildContext, SvelteMode, SvelteNode} from '../types.ts';
import {isNode, patternNames} from './ast.ts';
import type {Pattern} from './ast.ts';

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

/** Props name to spread; with no rest or props object, adds a `__ucfRest` rest or a `let __ucfRest = $props();` line. */
function propsName(text: MagicString, instance: AST.Script | null, block: Block, used: Set<string>, lines: string[]): string {
  const {id} =
    (instance?.content.body ?? [])
      .flatMap((statement) => (statement.type === 'VariableDeclaration' ? statement.declarations : []))
      .find(({init}) => init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === '$props') ??
    {};
  if (id?.type === 'Identifier') return id.name;
  const properties = id?.type === 'ObjectPattern' ? id.properties : [];
  const rest = properties.find((property) => property.type === 'RestElement');
  if (rest?.argument.type === 'Identifier') return rest.argument.name;
  const name = freshName(used, '__ucfRest');
  used.add(name);
  if (id?.type !== 'ObjectPattern') {
    lines.push(`let ${name} = $props();`);
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
function escapeOnce(text: MagicString, node: SvelteNode, block: Block): void {
  if (node.type !== 'RegularElement' && node.type !== 'SvelteElement') return;
  for (const attribute of node.attributes as SvelteNode[]) {
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

/** Spreads the parent's `data-v-*` props on every root, else warns in dev; `lines` end the instance script. */
export function forwardScope(
  text: MagicString,
  root: AST.Root,
  block: Block,
  ctx: BuildContext,
  used: Set<string>,
  mode: SvelteMode
) {
  const found: Roots = {elements: [], many: false, each: false};
  branchRoots(root.fragment.nodes as unknown as SvelteNode[], found);
  const lines: string[] = [];
  // An undecided block compiles either way: `$props()` would make it runes, `$$props` would break it as runes.
  if ((found.elements.length === 0 && !found.each) || mode === 'undecided') return {helpers: [], lines};
  if (mode === 'runes' && !found.many && !found.each) {
    let props = propsName(text, root.instance, block, used, lines);
    if (found.elements.some(({bound}) => bound.has(props))) {
      // `{:then props}` around a root hides the props; a `$derived` alias reads them without Svelte's warning.
      const alias = freshName(used, '__ucfProps');
      used.add(alias);
      lines.push(`const ${alias} = $derived(${props});`);
      props = alias;
    }
    for (const {node} of found.elements) {
      // Same offset as the stamp, so the spread lands after it.
      const nameEnd = block.contentStart + node.start + 1 + (node.name as string).length;
      text.appendLeft(nameEnd, ` {...${SCOPE_ATTRS}(${props})}`);
      escapeOnce(text, node, block);
    }
    return {helpers: [SCOPE_ATTRS], lines};
  }
  if (ctx.production) return {helpers: [], lines};
  const name = JSON.stringify(basename(ctx.filename, '.ucf'));
  const problem: Problem =
    mode === 'legacy' ? LEGACY : found.each ? ['renders an {#each} block as its root'] : ['renders more than one root'];
  const args = problem.map((part) => JSON.stringify(part)).join(', ');
  if (mode === 'legacy') lines.push(`;${WARN_FRAGMENT}($$props, ${name}, ${args});`);
  else {
    const props = propsName(text, root.instance, block, used, lines);
    // Called at top level, Svelte warns that the read captures only the initial props.
    lines.push(`;(() => ${WARN_FRAGMENT}(${props}, ${name}, ${args}))();`);
  }
  return {helpers: [WARN_FRAGMENT], lines};
}
