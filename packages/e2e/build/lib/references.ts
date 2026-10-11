import {parseAst, Visitor, type ESTree} from 'vite';
import {expect} from 'vitest';
import {keyName} from './build.ts';

interface Reference {
  specifier: string;
  keys: string[]; // import attribute keys, or the keys of the options object (and of its `with`)
}

function objectKeys(node: ESTree.Node | null | undefined): string[] {
  if (node?.type !== 'ObjectExpression') return node ? ['<not an object>'] : [];
  return node.properties.flatMap((prop) => {
    if (prop.type !== 'Property') return ['<spread>'];
    const name = keyName(prop.key) ?? '<computed>';
    return name === 'with' ? [name, ...objectKeys(prop.value)] : [name];
  });
}

// Every module reference of an output, ESM or Vite's SSR form, in source order.
export function moduleReferences(code: string): Reference[] {
  const found: Reference[] = [];
  const add = (source: ESTree.Node | null | undefined, keys: string[]) => {
    if (source?.type === 'Literal' && typeof source.value === 'string') found.push({specifier: source.value, keys});
  };
  const fromStatic = (node: {source: ESTree.Expression | null; attributes: ESTree.ImportAttribute[]}) =>
    add(
      node.source,
      node.attributes.map((attribute) => keyName(attribute.key) ?? '<computed>')
    );
  new Visitor({
    ImportDeclaration: fromStatic,
    ExportNamedDeclaration: fromStatic,
    ExportAllDeclaration: fromStatic,
    ImportExpression: (node) => add(node.source, objectKeys(node.options)),
    CallExpression: (node) => {
      const {callee} = node;
      if (callee.type !== 'Identifier' || !/^__vite_ssr_(dynamic_)?import__$/.test(callee.name)) return;
      // `__vite_ssr_import__` always gets `{importedNames}`: only an attribute's keys would be new.
      add(
        node.arguments[0],
        objectKeys(node.arguments[1]).filter((key) => key !== 'importedNames')
      );
    },
  }).visit(parseAst(code));
  return found;
}

export function expectNoAttribute(code: string) {
  for (const {specifier, keys} of moduleReferences(code)) {
    expect(keys, specifier).not.toContain('with');
    expect(keys, specifier).not.toContain('framework');
  }
}
