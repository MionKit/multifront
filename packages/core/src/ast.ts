import {visitorKeys} from 'oxc-parser';
import type {Node} from 'oxc-parser';

export function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const key of visitorKeys[node.type] ?? []) {
    const child: unknown = (node as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item === 'object' && 'type' in item) found.push(item as Node);
    }
  }
  return found;
}

/** Stands in for oxc's `Visitor`, missing from the wasm build the editor bundles load. */
export function walk(root: Node, enter: (node: Node) => void): void {
  enter(root);
  for (const child of children(root)) walk(child, enter);
}
