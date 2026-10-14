import type MagicString from 'magic-string';
import type {AST} from 'svelte/compiler';
import {MERGE_STYLE, MERGE_SVELTE_CLASS} from '../react/scopeHelper.ts';
import type {Block, HandledProps, SvelteNode, SveltePropsDeclaration, SvelteRootProp, SvelteScriptLang} from '../types.ts';
import {isNode, walk} from './ast.ts';

export const SVELTE_ROOT_PROPS = ['class', 'style'] as const;

export const SVELTE_MERGE: Record<SvelteRootProp, string> = {class: MERGE_SVELTE_CLASS, style: MERGE_STYLE};

// Svelte's own types for the attributes, from `svelte/elements`.
const MEMBER_TYPES: Record<SvelteRootProp, string> = {
  class: "class?: import('svelte/elements').ClassValue | null",
  style: 'style?: string | null',
};

type HandledRootProps = HandledProps<SvelteRootProp>;

export function propsDeclaration(instance: AST.Script | null): SveltePropsDeclaration | undefined {
  for (const statement of instance?.content.body ?? []) {
    if (statement.type !== 'VariableDeclaration') continue;
    const declarator = statement.declarations.find(
      ({init}) => init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === '$props'
    );
    if (declarator) return {declaration: statement as unknown as SvelteNode, declarator};
  }
  return undefined;
}

function isRootProp(name: unknown): name is SvelteRootProp {
  return (SVELTE_ROOT_PROPS as readonly unknown[]).includes(name);
}

function namedIn(node: unknown, names: Set<string>): boolean {
  if (!isNode(node)) return false;
  let inner = node;
  // `props!` and `(props as Props)` are still the props object.
  while (inner.type === 'TSNonNullExpression' || inner.type === 'TSAsExpression' || inner.type === 'TSSatisfiesExpression')
    inner = inner.expression as SvelteNode;
  return inner.type === 'Identifier' && names.has(inner.name as string);
}

function keyOf(node: SvelteNode, computed: unknown): unknown {
  if (computed) return node.type === 'Literal' ? node.value : undefined;
  return node.type === 'Identifier' ? node.name : node.type === 'Literal' ? node.value : undefined;
}

function readPattern(pattern: SvelteNode, found: HandledRootProps): void {
  for (const property of pattern.properties as SvelteNode[]) {
    if (property.type === 'RestElement') {
      const argument = property.argument as SvelteNode;
      if (argument.type === 'Identifier') found.spreads.add(argument.name as string);
      continue;
    }
    const name = keyOf(property.key as SvelteNode, property.computed);
    if (isRootProp(name)) found.handled.add(name);
  }
}

/** What the author handles: a `$props()` key, or a read of the props object anywhere, shadowed names too. */
export function handledRootProps(root: AST.Root, declaration: SveltePropsDeclaration | undefined): HandledRootProps {
  const found: HandledRootProps = {handled: new Set(), spreads: new Set()};
  const id = declaration?.declarator.id as unknown as SvelteNode | undefined;
  if (id?.type === 'Identifier') found.spreads.add(id.name as string);
  else if (id?.type === 'ObjectPattern') readPattern(id, found);
  if (found.spreads.size === 0) return found;
  walk([root.instance, root.fragment], (node) => {
    if (node.type === 'MemberExpression' && namedIn(node.object, found.spreads)) {
      const name = keyOf(node.property as SvelteNode, node.computed);
      if (isRootProp(name)) found.handled.add(name);
    } else if (node.type === 'VariableDeclarator' && isNode(node.id) && node.id.type === 'ObjectPattern') {
      const init = node.init as SvelteNode | null;
      // `const {style} = $derived(props)` keeps the read live, as Svelte asks.
      const derived = init?.type === 'CallExpression' && namedIn(init.callee, new Set(['$derived']));
      if (namedIn(derived ? (init.arguments as unknown[])[0] : init, found.spreads)) readPattern(node.id, found);
    }
  });
  return found;
}

/** The root props this root takes, none when it spreads the props. */
export function rootTakes(node: SvelteNode, {handled, spreads}: HandledRootProps): SvelteRootProp[] {
  const attributes = node.attributes as SvelteNode[];
  if (attributes.some(({type, expression}) => type === 'SpreadAttribute' && namedIn(expression, spreads))) return [];
  return SVELTE_ROOT_PROPS.filter((prop) => {
    if (handled.has(prop)) return false;
    // A `class` with no value is the author's.
    return ownAttribute(node, prop)?.value !== true;
  });
}

function ownAttribute(node: SvelteNode, prop: SvelteRootProp): SvelteNode | undefined {
  return (node.attributes as SvelteNode[]).find(({type, name}) => type === 'Attribute' && name === prop);
}

// Text between backticks reads as written.
const templateText = (text: string): string => text.replace(/\\|`|\$\{/g, (match) => `\\${match}`);

/** Merges each prop this root takes and has; `added`: the ones it lacks, `rewritten`: the attributes merged. */
export function mergeRootProps(
  text: MagicString,
  block: Block,
  node: SvelteNode,
  takes: SvelteRootProp[],
  props: string,
  merge: (prop: SvelteRootProp) => string
): {added: SvelteRootProp[]; rewritten: Set<SvelteNode>} {
  const offset = block.contentStart;
  const added: SvelteRootProp[] = [];
  const rewritten = new Set<SvelteNode>();
  for (const prop of takes) {
    const own = ownAttribute(node, prop);
    const extra = `${props}.${prop}`;
    if (!own) {
      added.push(prop);
      continue;
    }
    rewritten.add(own);
    const local = merge(prop);
    const {value} = own;
    if (isNode(value) && value.type === 'ExpressionTag') {
      const expression = value.expression as SvelteNode;
      // `{style}`: the attribute is its own value.
      if (expression.start === own.start + 1)
        text.overwrite(offset + own.start, offset + own.end, `${prop}={${local}(${prop}, ${extra})}`);
      else {
        text.prependRight(offset + expression.start, `${local}(`);
        text.appendLeft(offset + expression.end, `, ${extra})`);
      }
      continue;
    }
    // Text and tags: the template Svelte makes of them, each tag's source kept in place; `data` has entities decoded.
    const parts = value as SvelteNode[];
    const first = parts[0]!;
    const last = parts.at(-1)!;
    text.overwrite(offset + own.start, offset + first.start, `${prop}={${local}(\``);
    for (const part of parts) {
      if (part.type === 'Text') {
        if (part.end > part.start) text.overwrite(offset + part.start, offset + part.end, templateText(part.data as string));
        continue;
      }
      const expression = part.expression as SvelteNode;
      text.overwrite(offset + part.start, offset + expression.start, '${(');
      text.overwrite(offset + expression.end, offset + part.end, ") ?? ''}");
    }
    const close = `\`, ${extra})}`;
    if (own.end > last.end) text.overwrite(offset + last.end, offset + own.end, close);
    else text.appendLeft(offset + own.end, close);
  }
  return {added, rewritten};
}

/** `{class?: …; style?: …}` for the props some root takes, else undefined. */
export function rootPropsType(taken: Set<SvelteRootProp>): string | undefined {
  const members = SVELTE_ROOT_PROPS.filter((prop) => taken.has(prop)).map((prop) => MEMBER_TYPES[prop]);
  return members.length > 0 ? `{${members.join('; ')}}` : undefined;
}

// `@type {T}` in a JSDoc block: the offsets of `T`, in the comment's value.
function jsDocType(value: string): {start: number; end: number} | undefined {
  const tag = /@type\s*\{/.exec(value);
  if (!tag) return undefined;
  const start = tag.index + tag[0].length;
  let depth = 1;
  for (let index = start; index < value.length; index++) {
    if (value[index] === '{') depth++;
    else if (value[index] === '}' && --depth === 0) return {start, end: index};
  }
  return undefined;
}

/** Writes `type` into the `$props()` annotation, TS or JSDoc; an unannotated `$props()` keeps svelte2tsx's own. */
export function typePropsDeclaration(
  text: MagicString,
  block: Block,
  declaration: SveltePropsDeclaration,
  type: string,
  lang: SvelteScriptLang
): void {
  const offset = block.contentStart;
  const annotation = (declaration.declarator.id as unknown as SvelteNode).typeAnnotation as SvelteNode | undefined;
  const typed = isNode(annotation) ? (annotation.typeAnnotation as SvelteNode) : undefined;
  if (typed) {
    text.prependRight(offset + typed.start, '(');
    text.appendLeft(offset + typed.end, `) & ${type}`);
    return;
  }
  if (lang !== 'js') return;
  const comment = (
    declaration.declaration.leadingComments as {type: 'Line' | 'Block'; value: string; start: number}[] | undefined
  )?.findLast(({type: kind, value}) => kind === 'Block' && value.startsWith('*'));
  const found = comment && jsDocType(comment.value);
  if (!comment || !found) return;
  // The value starts after `/*`.
  text.prependRight(offset + comment.start + 2 + found.start, '(');
  text.appendLeft(offset + comment.start + 2 + found.end, `) & ${type}`);
}

/** The `$props()` line the build adds when the block has none, typed when some root takes a prop. */
export function propsLine(name: string, type: string | undefined, lang: SvelteScriptLang): string {
  if (!type) return `let {...${name}} = $props();`;
  return lang === 'ts' ? `let {...${name}}: ${type} = $props();` : `/** @type {${type}} */ let {...${name}} = $props();`;
}
