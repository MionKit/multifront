import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {AST} from 'svelte/compiler';
import {freshName} from '../ast.ts';
import {SCOPE_ATTRS, WARN_FRAGMENT} from '../react/scopeHelper.ts';
import type {Block, BuildContext} from '../types.ts';
import {isNode} from './ast.ts';
import type {Node} from './ast.ts';

/** The elements and components 5.2 stamps; as a root, each takes the parent's scope. */
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

interface Roots {
  elements: Node[];
  many: boolean;
  each: boolean;
}

function fragmentNodes(fragment: unknown): Node[] {
  return isNode(fragment) && fragment.type === 'Fragment' ? (fragment.nodes as Node[]) : [];
}

/** Each branch of `{#if}`, `{#key}`, `{#await}` and `<svelte:boundary>` is walked for its own roots. */
function branchRoots(nodes: Node[], found: Roots): void {
  const counted = nodes.filter(
    (node) => !NOT_ROOTS.has(node.type) && !(node.type === 'Text' && (node.data as string).trim() === '')
  );
  if (counted.length > 1) found.many = true;
  for (const node of counted) {
    if (node.type === 'IfBlock') {
      // An `{:else if}` is the one IfBlock of its `alternate`.
      branchRoots(fragmentNodes(node.consequent), found);
      branchRoots(fragmentNodes(node.alternate), found);
    } else if (node.type === 'KeyBlock') branchRoots(fragmentNodes(node.fragment), found);
    else if (node.type === 'AwaitBlock') {
      for (const key of ['pending', 'then', 'catch']) branchRoots(fragmentNodes(node[key]), found);
    } else if (node.type === 'SvelteBoundary') {
      // Its `{#snippet failed}` and `{#snippet pending}` render in place of its children.
      const children = fragmentNodes(node.fragment);
      branchRoots(
        children.filter((child) => child.type !== 'SnippetBlock'),
        found
      );
      for (const child of children) if (child.type === 'SnippetBlock') branchRoots(fragmentNodes(child.body), found);
    } else if (node.type === 'EachBlock') found.each = true;
    else if (ELEMENTS.has(node.type)) found.elements.push(node);
  }
}

function propsCall(init: unknown): boolean {
  return isNode(init) && init.type === 'CallExpression' && isNode(init.callee) && init.callee.name === '$props';
}

type Declarator = {id: Node; init: unknown};

function propsDeclarator(instance: AST.Script | null): Declarator | undefined {
  for (const statement of (instance?.content.body ?? []) as unknown as Node[]) {
    if (statement.type !== 'VariableDeclaration') continue;
    const found = (statement.declarations as Declarator[]).find(({init}) => propsCall(init));
    if (found) return found;
  }
  return undefined;
}

// The offset of the first character after `from` that is no space or comment.
function nextToken(content: string, from: number): number {
  let at = from;
  while (at < content.length) {
    if (/\s/.test(content[at]!)) at++;
    else if (content.startsWith('//', at)) at = content.indexOf('\n', at) === -1 ? content.length : content.indexOf('\n', at);
    else if (content.startsWith('/*', at)) at = content.indexOf('*/', at) + 2;
    else break;
  }
  return at;
}

/**
 * The name the props rest is read from: `props` of `let props = $props()`, `rest` of `{a, ...rest}`, or an added
 * `__ucfRest`, in the pattern or in a new `let __ucfRest = $props();` line.
 */
function propsName(text: MagicString, instance: AST.Script | null, block: Block, used: Set<string>, lines: string[]): string {
  const declarator = propsDeclarator(instance);
  const {id} = declarator ?? {};
  if (id?.type === 'Identifier') return id.name as string;
  const properties = (id?.properties ?? []) as Node[];
  const rest = properties.find((property) => property.type === 'RestElement');
  if (rest) return (rest.argument as Node).name as string;
  const name = freshName(used, '__ucfRest');
  used.add(name);
  if (id?.type !== 'ObjectPattern') {
    lines.push(`let ${name} = $props();`);
    return name;
  }
  const last = properties.at(-1);
  if (!last) text.appendLeft(block.contentStart + id.start + 1, `...${name}`);
  else {
    // A comma after a rest element is a syntax error: a trailing one comes before it.
    const after = nextToken(block.content, last.end);
    if (block.content[after] === ',') text.appendLeft(block.contentStart + after + 1, ` ...${name}`);
    else text.appendLeft(block.contentStart + last.end, `, ...${name}`);
  }
  return name;
}

/**
 * Beside a spread, Svelte's server render escapes a plain-text attribute twice (5.57.0: `data-x="<b>"` renders
 * `&amp;lt;b>`); as an expression it is escaped once.
 */
function escapeOnce(text: MagicString, node: Node, block: Block): void {
  if (node.type !== 'RegularElement' && node.type !== 'SvelteElement') return;
  for (const attribute of node.attributes as Node[]) {
    const parts = attribute.type === 'Attribute' && Array.isArray(attribute.value) ? (attribute.value as Node[]) : [];
    if (parts.length === 0 || parts.some((part) => part.type !== 'Text')) continue;
    if (!parts.some((part) => /[&<"]/.test(part.raw as string))) continue;
    const value = JSON.stringify(parts.map((part) => part.data as string).join(''));
    text.overwrite(
      block.contentStart + attribute.start,
      block.contentStart + attribute.end,
      `${attribute.name as string}={${value}}`
    );
  }
}

const LEGACY = ['is a legacy-mode Svelte component', 'Use $props() to make it a runes-mode component.'];

/** What `build()` adds besides the edits made here: helper imports and lines for the end of the instance script. */
export interface Forwarding {
  helpers: string[];
  lines: string[];
}

/** Spreads the parent's `data-v-*` props on every root, or warns in dev when the component cannot forward. */
export function forwardScope(
  text: MagicString,
  root: AST.Root,
  block: Block,
  ctx: BuildContext,
  used: Set<string>,
  runes: boolean
): Forwarding {
  const found: Roots = {elements: [], many: false, each: false};
  branchRoots(root.fragment.nodes as unknown as Node[], found);
  const lines: string[] = [];
  if (found.elements.length === 0 && !found.each) return {helpers: [], lines};
  if (runes && !found.many && !found.each) {
    const props = propsName(text, root.instance, block, used, lines);
    for (const node of found.elements) {
      // Same offset as the stamp, so the spread lands after it.
      const nameEnd = block.contentStart + node.start + 1 + (node.name as string).length;
      text.appendLeft(nameEnd, ` {...${SCOPE_ATTRS}(${props})}`);
      escapeOnce(text, node, block);
    }
    return {helpers: [SCOPE_ATTRS], lines};
  }
  if (ctx.production) return {helpers: [], lines};
  const name = JSON.stringify(basename(ctx.filename, '.ucf'));
  const problem = !runes ? LEGACY : found.each ? ['renders an {#each} block as its root'] : ['renders more than one root'];
  const args = problem.map((part) => JSON.stringify(part)).join(', ');
  if (!runes) lines.push(`;${WARN_FRAGMENT}($$props, ${name}, ${args});`);
  else {
    const props = propsName(text, root.instance, block, used, lines);
    // Called at top level, Svelte warns that the read captures only the initial props.
    lines.push(`;(() => ${WARN_FRAGMENT}(${props}, ${name}, ${args}))();`);
  }
  return {helpers: [WARN_FRAGMENT], lines};
}
