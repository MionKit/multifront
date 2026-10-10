import type MagicString from 'magic-string';
import type {JSXElementName, ModuleExportName, Program} from 'oxc-parser';
import {walk} from '../ast.ts';
import {FRAGMENT, REACT_MODULE} from './reactApis.ts';

interface FragmentNames {
  direct: Set<string>; // `F` of `import {Fragment as F} from 'react'`
  namespaces: Set<string>; // `R` of `R.Fragment`: the default or namespace import of 'react'
}

function exportName(name: ModuleExportName): string {
  return name.type === 'Literal' ? name.value : name.name;
}

// Module-level imports only: a local binding that shadows one is not followed.
function fragmentNames(program: Program): FragmentNames {
  const names: FragmentNames = {direct: new Set(), namespaces: new Set()};
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== REACT_MODULE || node.importKind === 'type') continue;
    for (const spec of node.specifiers) {
      if (spec.type !== 'ImportSpecifier') names.namespaces.add(spec.local.name);
      else if (spec.importKind === 'type') continue;
      else if (exportName(spec.imported) === FRAGMENT) names.direct.add(spec.local.name);
      else if (exportName(spec.imported) === 'default') names.namespaces.add(spec.local.name);
    }
  }
  return names;
}

function isFragment(name: JSXElementName, names: FragmentNames): boolean {
  if (name.type === 'JSXIdentifier') return names.direct.has(name.name);
  if (name.type !== 'JSXMemberExpression' || name.property.name !== FRAGMENT) return false;
  return name.object.type === 'JSXIdentifier' && names.namespaces.has(name.object.name);
}

/** Inserts ` data-v-<scopeId>=""` into every JSX opening element but React's Fragment; `offset` is the block's start. */
export function stampScope(text: MagicString, program: Program, offset: number, scopeId: string): void {
  const names = fragmentNames(program);
  const stamp = ` data-v-${scopeId}=""`;
  walk(program, (node) => {
    if (node.type !== 'JSXOpeningElement' || isFragment(node.name, names)) return;
    // After `<List<string>`: between the name and its type arguments the code no longer parses.
    text.appendLeft(offset + (node.typeArguments ?? node.name).end, stamp);
  });
}
