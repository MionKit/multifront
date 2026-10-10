import type MagicString from 'magic-string';
import type {JSXElementName, Node, Program} from 'oxc-parser';
import {children} from '../ast.ts';
import {keyName} from '../imports/rewrite.ts';
import {FRAGMENT, REACT_MODULE} from './reactApis.ts';

// `F` of `import {Fragment as F} from 'react'`; `R.Fragment` for its default or namespace import `R`.
function fragmentNames(program: Program): Set<string> {
  const names = new Set<string>();
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== REACT_MODULE || node.importKind === 'type') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.importKind === 'type') continue;
      // A namespace import reads like the default one: both give `R.Fragment`.
      const imported = spec.type === 'ImportSpecifier' ? keyName(spec.imported) : 'default';
      if (imported === FRAGMENT) names.add(spec.local.name);
      else if (imported === 'default') names.add(`${spec.local.name}.${FRAGMENT}`);
    }
  }
  return names;
}

function patternNames(node: Node | null): string[] {
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
function declaredIn(statements: Node[]): string[] {
  return statements.flatMap((node) => {
    if (node.type === 'VariableDeclaration') return node.declarations.flatMap(({id}) => patternNames(id));
    return (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id ? [node.id.name] : [];
  });
}

// The names a node binds for its own subtree.
function scopeNames(node: Node): string[] {
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

function isFragment(name: JSXElementName, fragments: Set<string>, shadowed: ReadonlySet<string>): boolean {
  if (name.type === 'JSXIdentifier') return fragments.has(name.name) && !shadowed.has(name.name);
  if (name.type !== 'JSXMemberExpression' || name.object.type !== 'JSXIdentifier') return false;
  return fragments.has(`${name.object.name}.${name.property.name}`) && !shadowed.has(name.object.name);
}

/** Inserts ` data-v-<scopeId>=""` into every JSX opening element but React's Fragment; `offset` is the block's start. */
export function stampScope(text: MagicString, program: Program, offset: number, scopeId: string): void {
  const fragments = fragmentNames(program);
  const imported = new Set([...fragments].map((name) => name.split('.')[0]!));
  const stamp = ` data-v-${scopeId}=""`;
  // `shadowed`: imported names a local binding hides here, so they no longer mean React's.
  const visit = (node: Node, outer: ReadonlySet<string>): void => {
    const own = scopeNames(node).filter((name) => imported.has(name));
    const shadowed = own.length > 0 ? new Set([...outer, ...own]) : outer;
    // After `<List<string>`: between the name and its type arguments the code no longer parses.
    if (node.type === 'JSXOpeningElement' && !isFragment(node.name, fragments, shadowed))
      text.appendLeft(offset + (node.typeArguments ?? node.name).end, stamp);
    for (const child of children(node)) visit(child, shadowed);
  };
  visit(program, new Set());
}
