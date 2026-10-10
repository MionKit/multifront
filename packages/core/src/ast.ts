import {visitorKeys} from 'oxc-parser';
import type {Node} from 'oxc-parser';

/** Every node under `root`, parents first; oxc's wasm build, which the editor bundles load, has no `Visitor`. */
export function walk(root: Node, enter: (node: Node) => void): void {
  enter(root);
  for (const key of visitorKeys[root.type] ?? []) {
    const child: unknown = (root as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item === 'object' && 'type' in item) walk(item as Node, enter);
    }
  }
}
