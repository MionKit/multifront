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

/** Not in `used`, so it neither shadows nor is shadowed. */
export function freshName(used: Set<string>, base: string): string {
  let name = base;
  for (let index = 1; used.has(name); index++) name = `${base}${index}`;
  return name;
}

export function patternNames(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern')
    return node.properties.flatMap((prop) => patternNames(prop.type === 'RestElement' ? prop.argument : prop.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(patternNames);
  if (node.type === 'AssignmentPattern') return patternNames(node.left);
  if (node.type === 'RestElement') return patternNames(node.argument);
  return node.type === 'TSParameterProperty' ? patternNames(node.parameter) : [];
}

// A `var` counts in its own block only.
export function declaredIn(statements: Node[]): string[] {
  return statements.flatMap((node) => {
    if (node.type === 'VariableDeclaration') return node.declarations.flatMap(({id}) => patternNames(id));
    return (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id ? [node.id.name] : [];
  });
}

// The names a node binds for its own subtree.
export function scopeNames(node: Node): string[] {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return [...(node.type === 'FunctionExpression' && node.id ? [node.id.name] : []), ...node.params.flatMap(patternNames)];
    case 'BlockStatement':
    case 'StaticBlock':
      return declaredIn(node.body);
    case 'SwitchStatement':
      return declaredIn(node.cases.flatMap(({consequent}) => consequent));
    case 'CatchClause':
      return patternNames(node.param);
    case 'ForStatement':
      return node.init ? declaredIn([node.init]) : [];
    case 'ForInStatement':
    case 'ForOfStatement':
      return declaredIn([node.left]);
    default:
      return [];
  }
}
