import {readFileSync} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, posix} from 'node:path';
import {scopeId} from '@multifront/core';
import {compile, compileModule, parse} from 'svelte/compiler';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR, literalSpecifiers} from '../fixtures/index.ts';
import {packLibrary, publint} from '../consumer/lib/pack.ts';
import {
  buildFixtureLibrary,
  copyLibraryChecks,
  edited,
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
const SVELTE_CHILDREN = '{@render children?.()}';
const CHILD = `<script lang="ts">
  import Icon from './Icon.ucf'
  import { count } from './count.svelte.js'

  let { label }: { label: string } = $props()
</script>

<button class="child" onclick={() => count.value++}><Icon /> {label}: {count.value}</button>

<style lang="scss">
  // SCSS only: Svelte's own CSS parser rejects this comment and the variable.
  $color: rgb(10, 20, 30);

  .child {
    color: $color;

    &:hover {
      color: rgb(40, 50, 60);
    }
  }
</style>
`;
const COUNT = 'interface Count {\n  value: number;\n}\n\nexport const count: Count = $state({value: 0});\n';
const COUNT_JS =
  "import Icon from './Icon.ucf';\n\nexport const count = $state({value: 0});\nexport const hasIcon = Icon !== undefined;\n";
const SVELTE_CONFIG =
  "import {vitePreprocess} from '@sveltejs/vite-plugin-svelte';\n\nexport default {preprocess: vitePreprocess()};\n";
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

// Card's `<svelte>` block imports `from` and renders it as `tag`.
function cardUsing(tag: string, from: string): string {
  const card = edited(CARD, SVELTE_IMPORTS, `${SVELTE_IMPORTS}  import ${tag} from '${from}'\n`);
  return edited(card, SVELTE_CHILDREN, `${SVELTE_CHILDREN}\n    <${tag} label="child" />`);
}

function expectCompiles(file: string, code: string): void {
  for (const generate of ['client', 'server'] as const) {
    const {warnings} = file.endsWith('.svelte')
      ? compile(code, {filename: file, generate})
      : compileModule(code, {filename: file, generate});
    expect(
      warnings.map(({code: warning, message}) => `${warning}: ${message}`),
      file
    ).toEqual([]);
  }
}

// The string-literal specifiers of a component's scripts and markup, `import()` included.
function svelteSpecifiers(file: string, code: string): string[] {
  const {module, instance, fragment} = parse(code, {modern: true, filename: file});
  return literalSpecifiers([module, instance, fragment]);
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
      expectCompiles(file, code);
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
    ['count.svelte.ts', COUNT, 'export const count = $state({ value: 0 });\n'],
    ['count.svelte.js', COUNT_JS, COUNT_JS.replace("'./Icon.ucf'", '"./Icon.svelte"')],
  ])('ships a plain .svelte file, preprocessed, and %s as source with types', async (module, content, shipped) => {
    const index = readFileSync(join(LIBRARY_DIR, 'src', 'index.ts'), 'utf8');
    const edits = [
      {file: 'src/Child.svelte', content: CHILD},
      {file: `src/${module}`, content},
      {file: 'src/Card.ucf', content: cardUsing('Child', './Child.svelte')},
      {file: 'src/index.ts', content: `${index}export {default as Child} from './Child.svelte';\n`},
      // Reached by nothing: never shipped.
      {file: 'src/Unused.svelte', content: '<p>unused</p>\n'},
      {file: 'svelte.config.js', content: SVELTE_CONFIG},
    ];
    await withEditedLibrary(edits, async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['svelte']});
      try {
        const result = resultOf(built.results, 'svelte');
        const output = (file: string) => readOutput(result, file);
        const plain = ['Child.svelte', 'Child.svelte.d.ts', 'count.svelte.d.ts', 'count.svelte.js'];
        expect(result.files).toEqual([...FILES, ...plain].sort());
        const child = output('Child.svelte');
        expect(svelteSpecifiers('Child.svelte', child)).toEqual(['./Icon.svelte', './count.svelte.js']);
        expect(child).toContain('let { label }: { label: string } = $props()');
        expect(child).not.toContain('lang="scss"');
        expect(child).toMatch(/\.child:hover\s*\{/);
        expect(output('styles.css')).not.toContain('child');
        expect(output('count.svelte.js')).toBe(shipped);
        expectCompiles('Child.svelte', child);
        expectCompiles('count.svelte.js', output('count.svelte.js'));
        expect(svelteSpecifiers('Card.svelte', output('Card.svelte'))).toContain('./Child.svelte');
        expect(specifiersOf('index.js', output('index.js'))).toContain('./Child.svelte');
        expect(specifiersOf('index.js', output('index.js'))).not.toContain('./Child.svelte.js');
        expect(output('Child.svelte.d.ts')).toMatch(/label: string/);
        expect(output('count.svelte.d.ts')).toMatch(/value: number/);
      } finally {
        await built.remove();
      }
    });
  });

  it("runs the library's svelte.config.js preprocessors over a shipped component, its types from the source", async () => {
    const config = SVELTE_CONFIG.replace('vitePreprocess()', 'vitePreprocess({script: true})');
    await withEditedLibrary([{file: 'svelte.config.js', content: config}], async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['svelte']});
      try {
        const result = resultOf(built.results, 'svelte');
        const card = readOutput(result, 'Card.svelte');
        expect(card).toContain('<script>');
        expect(card).not.toContain('lang="ts"');
        expect(card).toContain('let { title, children, ...__ucfRest } = $props();');
        expectCompiles('Card.svelte', card);
        expect(readOutput(result, 'Card.svelte.d.ts')).toMatch(/title: string/);
      } finally {
        await built.remove();
      }
    });
  });

  it.each([
    ['src/Child.svelte', "<script>\n  import { cx } from '~/utils/cx.js'\n</script>\n\n<p class={cx('child')}>child</p>\n"],
    ['src/count.svelte.ts', "import {cx} from '~/utils/cx.js';\n\nexport const count = $state({value: cx('a')});\n"],
  ])('fails on a bare import a consumer cannot resolve in a plain Svelte file, %s', async (file, content) => {
    const edits = [
      {file: 'src/Child.svelte', content: CHILD},
      {file: 'src/count.svelte.ts', content: COUNT},
      {file, content},
      {file: 'src/Card.ucf', content: cardUsing('Child', './Child.svelte')},
      {file: 'svelte.config.js', content: SVELTE_CONFIG},
    ];
    await withEditedLibrary(edits, async (root) => {
      const vite = {logLevel: 'silent' as const, resolve: {alias: {'~': join(root, 'src')}}};
      await expect(buildFixtureLibrary(root, {frameworks: ['svelte'], dts: false, vite})).rejects.toThrow(
        `buildLibrary: ${file} imports "~/utils/cx.js": a shipped svelte file can import relative files and peers only`
      );
    });
  });

  it('fails on a plain .svelte file written where a component ships', async () => {
    const edits = [
      {file: 'src/Plain.ucf', content: '<svelte>\n  <p>component</p>\n</svelte>\n'},
      {file: 'src/Plain.svelte', content: '<p>plain</p>\n'},
      {file: 'src/Card.ucf', content: cardUsing('Plain', './Plain.svelte')},
    ];
    await withEditedLibrary(edits, async (root) => {
      await expect(buildFixtureLibrary(root, {frameworks: ['svelte'], dts: false})).rejects.toThrow(
        'buildLibrary: src/Plain.ucf and src/Plain.svelte would both be written as Plain.svelte'
      );
    });
  });

  it('fails on a bare import a consumer cannot resolve, like an alias into src, in a <svelte> block', async () => {
    const card = edited(CARD, SVELTE_IMPORTS, `${SVELTE_IMPORTS}  import { cx as join } from '~/utils/cx.js'\n`);
    await withEditedLibrary([{file: 'src/Card.ucf', content: card}], async (root) => {
      const vite = {logLevel: 'silent' as const, resolve: {alias: {'~': join(root, 'src')}}};
      await expect(buildFixtureLibrary(root, {frameworks: ['svelte'], vite})).rejects.toThrow(
        'buildLibrary: src/Card.ucf imports "~/utils/cx.js" in its <svelte> block: a shipped svelte file can import relative files and peers only'
      );
    });
  });

  it("points a nested plain module's import() of a component at its .svelte file", async () => {
    const index = readFileSync(join(LIBRARY_DIR, 'src', 'index.ts'), 'utf8');
    const edits = [
      {file: 'src/utils/cards.ts', content: "export const loadCard = () => import('../Card.ucf');\n"},
      {file: 'src/index.ts', content: `${index}export {loadCard} from './utils/cards.js';\n`},
    ];
    await withEditedLibrary(edits, async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['svelte'], dts: false});
      try {
        const result = resultOf(built.results, 'svelte');
        expect(specifiersOf('cards.js', readOutput(result, 'utils/cards.js'))).toEqual(['../Card.svelte']);
        expect(result.files).not.toContain('Card.js');
      } finally {
        await built.remove();
      }
    });
  });

  it('fails on a file of src that would be written where the scope helper ships', async () => {
    const card = edited(CARD, SVELTE_IMPORTS, `${SVELTE_IMPORTS}  import './_ucf/scopeAttrs.js'\n`);
    const edits = [
      // A side effect, so the build keeps the module.
      {file: 'src/_ucf/scopeAttrs.ts', content: "console.info('loaded');\n"},
      {file: 'src/Card.ucf', content: card},
    ];
    await withEditedLibrary(edits, async (root) => {
      await expect(buildFixtureLibrary(root, {frameworks: ['svelte']})).rejects.toThrow(
        'buildLibrary: _ucf/scopeAttrs.js is the name of the shipped scope helper; rename that file in src'
      );
    });
  });
});
