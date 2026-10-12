import {parseAst, Visitor, type ESTree, type Plugin} from 'vite';
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

interface Resolution {
  environment: string;
  id: string;
  importer: string; // its path, query dropped
  query: string; // the importer's
}

/** Logs each `.ucf` import before any plugin resolves it, so the specifier still holds what our rewrite put there. */
export function resolutionRecorder() {
  const calls: Resolution[] = [];
  const plugin: Plugin = {
    name: 'ucf-resolution-recorder',
    resolveId: {
      order: 'pre',
      handler(id, importer) {
        if (!id.includes('.ucf') || !importer) return;
        const [path, query = ''] = importer.split('?');
        calls.push({environment: this.environment.name, id, importer: path!, query});
      },
    },
  };
  const from = (importer: string, environment = 'client') =>
    calls.filter((call) => call.importer.endsWith(importer) && call.environment === environment);
  return {plugin, from};
}

/** A module's `.ucf` references from `/components/` on: dev URLs start with `/@fs`, SSR ones do not. */
export function ucfPaths(code: string): string[] {
  return moduleReferences(code)
    .map(({specifier}) => specifier.split('?')[0]!)
    .filter((path) => path.includes('.ucf'))
    .map((path) => path.slice(path.indexOf('/components/')));
}
