import {visitorKeys} from 'oxc-parser';
import type {Node} from 'oxc-parser';

/** Stands in for oxc's `Visitor`, missing from the wasm build the editor bundles load. */
export function walk(root: Node, enter: (node: Node) => void): void {
  enter(root);
  for (const key of visitorKeys[root.type] ?? []) {
    const child: unknown = (root as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item === 'object' && 'type' in item) walk(item as Node, enter);
    }
  }
}
