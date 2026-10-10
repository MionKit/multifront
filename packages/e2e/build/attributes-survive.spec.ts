import {rm} from 'node:fs/promises';
import {basename} from 'node:path';
import {createServer, parseAst, Visitor, type ESTree, type Plugin, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp} from '../fixtures/index.ts';
import {withNodeEnv} from './lib/build.ts';

// Spec 4.4's post rewrite needs `with { framework }` still on the import when post plugins run.
const IMPORTERS = ['plain.ts', 'component.tsx'];

let root: string;
let server: ViteDevServer;
const recorded = new Map<string, string>();

// Added after the app's own plugins, so it gets the code the last post plugin would get.
const recorder: Plugin = {
  name: 'attribute-recorder',
  enforce: 'post',
  transform(code, id) {
    const file = basename(id.split('?')[0]!);
    if (IMPORTERS.includes(file)) recorded.set(`${this.environment.name}:${file}`, code);
  },
};

beforeAll(async () => {
  root = await copyApp('attribute-canary');
  // plugin-react turns Fast Refresh off under an outside NODE_ENV=production.
  server = await withNodeEnv('development', () =>
    createServer({
      root,
      logLevel: 'silent',
      plugins: [recorder],
      server: {middlewareMode: true, ws: false},
      optimizeDeps: {noDiscovery: true},
    })
  );
});

afterAll(async () => {
  await server?.close();
  if (root) await rm(root, {recursive: true, force: true});
});

function keyName(key: ESTree.ImportAttributeKey | ESTree.PropertyKey): string | undefined {
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

function property(object: ESTree.Expression | null | undefined, name: string): ESTree.Expression | undefined {
  if (object?.type !== 'ObjectExpression') return undefined;
  for (const prop of object.properties)
    if (prop.type === 'Property' && keyName(prop.key) === name) return prop.value as ESTree.Expression;
  return undefined;
}

// Each import of `./target.js` as `[node type, its framework attribute]`.
function targetImports(code: string): [string, string | undefined][] {
  const found: [string, string | undefined][] = [];
  const add = (type: string, source: ESTree.Expression | null, framework: string | undefined) => {
    if (source?.type === 'Literal' && source.value === './target.js') found.push([type, framework]);
  };
  const fromStatic = (node: {type: string; source: ESTree.Expression | null; attributes: ESTree.ImportAttribute[]}) =>
    add(node.type, node.source, node.attributes.find((attr) => keyName(attr.key) === 'framework')?.value.value);
  new Visitor({
    ImportDeclaration: fromStatic,
    ExportNamedDeclaration: fromStatic,
    ExportAllDeclaration: fromStatic,
    ImportExpression: (node) => {
      const framework = property(property(node.options, 'with'), 'framework') as ESTree.StringLiteral | undefined;
      add(node.type, node.source, framework?.value);
    },
  }).visit(parseAst(code));
  return found.sort(([left], [right]) => left.localeCompare(right));
}

describe('import attributes survive Vite and plugin-react', () => {
  for (const environment of ['client', 'ssr'] as const)
    for (const file of IMPORTERS)
      it(`keeps framework on all four imports of ${file} (${environment})`, async () => {
        await server.environments[environment].transformRequest(`/${file}`);
        const code = recorded.get(`${environment}:${file}`);
        expect(code).toBeDefined();
        expect(targetImports(code!)).toEqual([
          ['ExportAllDeclaration', 'react'],
          ['ExportNamedDeclaration', 'react'],
          ['ImportDeclaration', 'react'],
          ['ImportExpression', 'react'],
        ]);
      });

  it('ran plugin-react on component.tsx', async () => {
    await server.environments.client.transformRequest('/component.tsx');
    expect(recorded.get('client:component.tsx')).toContain('$RefreshReg$');
  });
});
