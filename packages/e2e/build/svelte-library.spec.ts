import {readFileSync} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, posix} from 'node:path';
import {scopeId} from '@multifront/core';
import {compile, parse} from 'svelte/compiler';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {packLibrary, publint} from '../consumer/lib/pack.ts';
import {
  buildFixtureLibrary,
  copyLibraryChecks,
  readOutput,
  resultOf,
  specifiersOf,
  typeCheck,
  typeSpecifiersOf,
  withEditedLibrary,
} from './lib/library.ts';
import type {BuiltLibrary} from './lib/library.ts';

// Dependencies first: Card renders Icon, Panel renders Counter.
const COMPONENTS = ['Button', 'Icon', 'Card', 'Counter', 'Panel', 'Tooltip', 'forms/Field'];
const FILES = COMPONENTS.flatMap((name) => [`${name}.svelte`, `${name}.svelte.d.ts`, `${name}.css`])
  .concat(['index.js', 'index.d.ts', 'utils/cx.js', 'utils/cx.js.map', 'utils/cx.d.ts', '_ucf/scopeAttrs.js'])
  .concat(['styles.css', 'package.json', 'README.md', 'LICENSE'])
  .sort();
const FIXTURE = JSON.parse(readFileSync(join(LIBRARY_DIR, 'package.json'), 'utf8')) as Record<string, unknown>;
const CARD = readFileSync(join(LIBRARY_DIR, 'src', 'Card.ucf'), 'utf8');
// Only in Card's `<svelte>` block.
const SVELTE_IMPORTS = "  import type { Snippet } from 'svelte'\n  import Icon from './Icon.ucf'\n";
const SVELTE_PROPS = 'let { title, children }: { title: string; children?: Snippet } = $props()';
const require = createRequire(import.meta.url);
const SHIMS = createRequire(require.resolve('@multifront/language-tools')).resolve('svelte2tsx/svelte-shims-v4.d.ts');

let library: BuiltLibrary;
let tarballs: Awaited<ReturnType<typeof packLibrary>>;
let checks: string;

beforeAll(async () => {
  library = await buildFixtureLibrary(LIBRARY_DIR, {frameworks: ['svelte']});
  tarballs = await packLibrary(library.outDir);
  checks = await copyLibraryChecks(library.outDir);
  await copyFile(SHIMS, join(checks, 'svelte-shims-v4.d.ts'));
});

afterAll(async () => {
  await library?.remove();
});

function svelte() {
  return resultOf(library.results, 'svelte');
}

function read(file: string): string {
  return readOutput(svelte(), file);
}

function edited(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`the fixture has no ${JSON.stringify(from)}`);
  return source.replace(from, to);
}

// The string-literal specifiers of a component's scripts and markup, `import()` included.
function svelteSpecifiers(file: string, code: string): string[] {
  const root = parse(code, {modern: true, filename: file});
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type?: string; value?: unknown}};
    if (node.type !== 'Literal' && node.source?.type === 'Literal' && typeof node.source.value === 'string')
      found.push(node.source.value);
    for (const child of Object.values(node)) visit(child);
  };
  visit([root.module, root.instance, root.fragment]);
  return found;
}

function specifiersIn(file: string): string[] {
  if (file.endsWith('.svelte')) return svelteSpecifiers(file, read(file));
  return file.endsWith('.d.ts') ? typeSpecifiersOf(file, read(file)) : specifiersOf(file, read(file));
}

// A declaration names the JS or `.svelte` file it types.
function shippedFile(from: string, specifier: string): string {
  const file = posix.join(posix.dirname(from), specifier);
  if (!from.endsWith('.d.ts')) return file;
  return file.endsWith('.js') ? file.replace(/\.js$/, '.d.ts') : `${file}.d.ts`;
}

describe('buildLibrary(): the Svelte package', () => {
  it('writes the svelte-package layout: uncompiled components, their CSS and types, the index, the plain modules', () => {
    expect(svelte().packageName).toBe('@mf-fixture/ui-svelte');
    expect(svelte().files).toEqual(FILES);
    expect(svelte().skipped).toEqual(['Badge.ucf', 'VueOnly.ucf']);
  });

  it('ships each component uncompiled, compiling with the real Svelte compiler, with no .ucf or virtual id left', () => {
    for (const file of svelte().files.filter((name) => name.endsWith('.svelte'))) {
      const code = read(file);
      expect(code, file).toContain('</script>');
      for (const generate of ['client', 'server'] as const) {
        const {warnings} = compile(code, {filename: file, generate});
        expect(
          warnings.map(({code: warning, message}) => `${warning}: ${message}`),
          file
        ).toEqual([]);
      }
    }
    expect(read('Card.svelte')).toContain('{@render children?.()}');
    for (const file of svelte().files.filter((name) => /\.(svelte|js|d\.ts)$/.test(name))) {
      expect(read(file), file).not.toMatch(/\.ucf|virtual:|\0|\?ucf/);
    }
  });

  it('points every relative import of a component, the index and a declaration at a file of the package', () => {
    const files = new Set(svelte().files);
    for (const file of svelte().files.filter((name) => /\.(svelte|js|d\.ts)$/.test(name))) {
      for (const specifier of specifiersIn(file).filter((name) => name.startsWith('.'))) {
        expect(files.has(shippedFile(file, specifier)), `${file} imports ${specifier}`).toBe(true);
      }
    }
    expect(specifiersIn('Panel.svelte')).toEqual(expect.arrayContaining(['./Counter.svelte', './Panel.css']));
    expect(specifiersIn('forms/Field.svelte')).toContain('../_ucf/scopeAttrs.js');
    expect(specifiersIn('index.js')).toContain('./Card.svelte');
    expect(specifiersIn('index.d.ts')).toContain('./Card.svelte');
  });

  it("inlines Card's class map, with the class names of its CSS file", () => {
    const {instance} = parse(read('Card.svelte'), {modern: true});
    const declarations = instance!.content.body.flatMap((node) => (node.type === 'VariableDeclaration' ? node.declarations : []));
    const style = declarations.find(({id}) => id.type === 'Identifier' && id.name === '__ucfStyle')?.init;
    if (style?.type !== 'ObjectExpression') throw new Error('Card.svelte has no inlined __ucfStyle');
    const classes = style.properties.map((property) =>
      property.type === 'Property' && property.value.type === 'Literal' ? property.value.value : undefined
    );
    expect(classes).toHaveLength(2);
    for (const name of classes) expect(read('Card.css')).toContain(`.${String(name)} {`);
  });

  it('ships the CSS of the CSS step: the scope of Card.ucf, and styles.css dependencies first', () => {
    const id = scopeId('src/Card.ucf', CARD, true);
    expect(read('Card.css')).toContain(`[data-v-${id}]`);
    expect(read('Card.svelte')).toContain(`data-v-${id}=""`);
    expect(read('styles.css')).toBe(COMPONENTS.map((name) => read(`${name}.css`)).join(''));
  });

  it('types the package for real tsc with the svelte shims: right props pass, wrong ones fail', async () => {
    expect(await typeCheck('tsc', checks, 'tsconfig.svelte.json')).toBe('');
  });

  it('writes the package.json: types and svelte conditions, the svelte field, the svelte peer only', () => {
    const entry = (name: string) => ({types: `./${name}.svelte.d.ts`, svelte: `./${name}.svelte`});
    const expected = {
      name: '@mf-fixture/ui-svelte',
      version: '1.2.3',
      description: FIXTURE.description,
      license: 'MIT',
      author: 'multifront fixtures',
      repository: FIXTURE.repository,
      homepage: FIXTURE.homepage,
      keywords: ['multifront', 'fixture'],
      type: 'module',
      sideEffects: ['*.css'],
      types: './index.d.ts',
      svelte: './index.js',
      exports: {
        '.': {types: './index.d.ts', svelte: './index.js'},
        ...Object.fromEntries([...COMPONENTS].sort().map((name) => [`./${name}`, entry(name)])),
        './styles.css': './styles.css',
        './*.css': './*.css',
        './package.json': './package.json',
      },
      peerDependencies: {svelte: '^5.0.0'},
    };
    const packageJson = JSON.parse(read('package.json')) as Record<string, unknown>;
    expect(packageJson).toEqual(expected);
    expect(Object.keys(packageJson)).toEqual(Object.keys(expected));
    expect(Object.keys(packageJson.exports as object)).toEqual(Object.keys(expected.exports));
  });

  it('packs a tarball that passes publint, warnings included', async () => {
    const {code, output} = await publint(tarballs.svelte!);
    expect(code, output).toBe(0);
    expect(output).toContain('All good!');
  });
});

describe('buildLibrary(): Svelte types and plain Svelte files', () => {
  it('gives a type-only module its .d.ts', async () => {
    const card = edited(
      edited(CARD, SVELTE_IMPORTS, `${SVELTE_IMPORTS}  import type { Tone } from './types.js'\n`),
      SVELTE_PROPS,
      'let { title, tone, children }: { title: string; tone?: Tone; children?: Snippet } = $props()'
    );
    const edits = [
      {file: 'src/Card.ucf', content: card},
      {file: 'src/types.ts', content: "export type Tone = 'info' | 'warn';\n"},
    ];
    await withEditedLibrary(edits, async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['svelte']});
      try {
        const result = resultOf(built.results, 'svelte');
        expect(result.files).toContain('types.d.ts');
        expect(result.files).not.toContain('types.js');
        expect(typeSpecifiersOf('Card.svelte.d.ts', readOutput(result, 'Card.svelte.d.ts'))).toContain('./types.js');
      } finally {
        await built.remove();
      }
    });
  });

  it.each([
    ['src/Child.svelte', '<p>child</p>\n', "import Child from './Child.svelte'"],
    ['src/count.svelte.ts', 'export const count = $state({value: 0});\n', "import { count } from './count.svelte.js'"],
  ])('fails on a plain Svelte file, %s, which would ship compiled', async (file, content, use) => {
    const card = edited(CARD, SVELTE_IMPORTS, `${SVELTE_IMPORTS}  ${use}\n`);
    await withEditedLibrary(
      [
        {file, content},
        {file: 'src/Card.ucf', content: card},
      ],
      async (root) => {
        await expect(buildFixtureLibrary(root, {frameworks: ['svelte']})).rejects.toThrow(
          `buildLibrary: ${file}: a library package ships svelte code from .ucf <svelte> blocks only`
        );
      }
    );
  });
});
