import {rm} from 'node:fs/promises';
import {basename} from 'node:path';
import {createServer, parseAst, type Plugin, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp} from '../fixtures/index.ts';

// Spec 4.4's post rewrite needs `with { framework }` still on the import when post plugins run.
const IMPORTERS = ['plain.ts', 'component.tsx'];
const ENVIRONMENTS = ['client', 'ssr'] as const;

type Node = {type: string; [key: string]: unknown};
type Property = {key: {name?: string; value?: string}; value: Node & {value?: unknown}};

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
  server = await createServer({
    root,
    logLevel: 'silent',
    plugins: [recorder],
    server: {middlewareMode: true, ws: false},
    optimizeDeps: {noDiscovery: true},
  });
});

afterAll(async () => {
  await server?.close();
  await rm(root, {recursive: true, force: true});
});

function keyName(property: Property): string | undefined {
  return property.key.name ?? property.key.value;
}

function frameworkOf(properties: Property[] | undefined): unknown {
  return properties?.find((property) => keyName(property) === 'framework')?.value.value;
}

// Each import of `./target.js` as `[node type, its framework attribute]`.
function targetImports(code: string): [string, unknown][] {
  const found: [string, unknown][] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as Node;
    const source = node.source as {value?: unknown} | undefined;
    if (source?.value === './target.js') {
      if (node.type === 'ImportExpression') {
        const options = node.options as {properties?: Property[]} | null;
        const withKey = options?.properties?.find((property) => keyName(property) === 'with');
        found.push([node.type, frameworkOf(withKey?.value.properties as Property[] | undefined)]);
      } else found.push([node.type, frameworkOf(node.attributes as Property[])]);
    }
    for (const key in node) if (key !== 'source') visit(node[key]);
  };
  visit(parseAst(code));
  return found.sort(([left], [right]) => left.localeCompare(right));
}

describe('import attributes survive Vite and plugin-react', () => {
  for (const environment of ENVIRONMENTS)
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
