import type {AST} from 'svelte/compiler';

export type Node = AST.BaseNode & Record<string, unknown>;

export const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

// `visit` returning false skips the node's children.
export type Visit = (node: Node, parent: Node | undefined, key: string) => false | void;

export function walk(value: unknown, visit: Visit, parent?: Node, key = ''): void {
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
