import type {AST} from 'svelte/compiler';
import type {SvelteNode} from '../types.ts';

type Statement = AST.Script['content']['body'][number];
export type Pattern = Extract<Statement, {type: 'VariableDeclaration'}>['declarations'][number]['id'];

export const isNode = (value: unknown): value is SvelteNode =>
  typeof value === 'object' && value !== null && typeof (value as SvelteNode).type === 'string';

// `visit` returning false skips the node's children.
type Visit = (node: SvelteNode, parent: SvelteNode | undefined, key: string) => false | void;

export function walk(value: unknown, visit: Visit, parent?: SvelteNode, key = ''): void {
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

export function patternNames(pattern: Pattern | null, names: Set<string>): void {
  if (pattern?.type === 'Identifier') names.add(pattern.name);
  else if (pattern?.type === 'ObjectPattern') {
    for (const property of pattern.properties) patternNames(property.type === 'RestElement' ? property : property.value, names);
  } else if (pattern?.type === 'ArrayPattern') for (const element of pattern.elements) patternNames(element, names);
  else if (pattern?.type === 'AssignmentPattern') patternNames(pattern.left, names);
  else if (pattern?.type === 'RestElement') patternNames(pattern.argument, names);
}
