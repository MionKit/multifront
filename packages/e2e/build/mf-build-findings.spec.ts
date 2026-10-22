// M6.1 QA seams: errors of other steps and earlier milestones through the real mf-build bin, by spec 8.1's rules.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {checkBlocks, findingOf, splitBlocks} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {LIBRARY_DIR, readComponent} from '../fixtures/index.ts';
import {locate} from '../editor/lib/tsserver.ts';
import {edited, report, runMfBuild, withEditedLibrary} from './lib/library.ts';

/** Card.front with both script blocks typing their props from `specifier`, by `import type` only: no chunk for it. */
function typedCard(specifier: string): string {
  const typeImport = `  import type { CardTitle } from '${specifier}'\n`;
  let card = readFileSync(join(LIBRARY_DIR, 'src', 'Card.front'), 'utf8');
  card = edited(card, "  import Icon from './Icon.front'\n", `  import Icon from './Icon.front'\n${typeImport}`);
  card = edited(card, 'defineProps<{ title: string }>()', 'defineProps<CardTitle>()');
  card = edited(card, "  import type { ReactNode } from 'react'\n", `  import type { ReactNode } from 'react'\n${typeImport}`);
  return edited(card, '{ title: string; children?: ReactNode }', 'CardTitle & { children?: ReactNode }');
}

describe('mf-build on a vue-only-style component (6.1.4 through 6.1.5)', () => {
  const {source} = readComponent('invalid/VueOnlyStyle.front');
  const edits = [{file: 'src/VueOnlyStyle.front', content: source}];

  it.each(['react', 'svelte'] as const)(
    'prints every v-bind() and :slotted() spot at its .front position in the %s build, exit 1',
    async (framework) => {
      await withEditedLibrary(edits, async (root) => {
        const split = splitBlocks(source, join(root, 'src', 'VueOnlyStyle.front'));
        const expected = checkBlocks(split)
          .filter(({code}) => code === 'vue-only-style')
          .map((diagnostic) => ({...findingOf(diagnostic, split), file: 'src/VueOnlyStyle.front', framework}));
        expect(expected.length).toBeGreaterThan(0);
        const json = await runMfBuild(root, ['--framework', framework, '--no-dts', '--format', 'json']);
        expect(json.stderr).toBe('');
        expect(json.code).toBe(1);
        expect(report(json.stdout)).toEqual({
          findings: expected,
          errorCount: expected.length,
          warningCount: 0,
          packages: [],
        });
        const text = await runMfBuild(root, ['--framework', framework, '--no-dts']);
        expect(text.code).toBe(1);
        const lines = expected.map(
          ({line, column, message}) =>
            `src/VueOnlyStyle.front:${line}:${column}: error vue-only-style (${framework}): ${message}\n`
        );
        expect(text.stdout).toBe(`${lines.join('')}mf-build: ${expected.length} errors in the ${framework} build\n`);
      });
    }
  );

  it('builds the same component in the vue package, exit 0', async () => {
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--no-dts']);
      expect(run).toEqual({
        code: 0,
        stdout: expect.stringMatching(/^mf-build: built 1 package in dist: vue \d+ files\n$/),
        stderr: '',
      });
    });
  });
});

describe('mf-build on a type-only module whose name differs only by case from a component (6.1.2 goal)', () => {
  const edits = [
    {file: 'src/Card.front', content: typedCard('./card.js')},
    // Reached by type-only imports: no chunk, only tsc's card.d.ts beside Card.d.ts.
    {file: 'src/card.ts', content: 'export interface CardTitle {\n  title: string;\n}\n'},
  ];

  it.each(['react', 'vue'] as const)('fails the %s build instead of shipping Card.d.ts and card.d.ts', async (framework) => {
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', framework, '--format', 'json']);
      const shipped = existsSync(join(root, 'dist', framework)) ? readdirSync(join(root, 'dist', framework)) : [];
      expect(shipped.filter((file) => file.toLowerCase() === 'card.d.ts').sort()).not.toEqual(['Card.d.ts', 'card.d.ts']);
      expect(run.code).toBe(1);
      const {findings} = report(run.stdout);
      expect(findings).toEqual([
        expect.objectContaining({
          code: 'name-clash',
          framework,
          message: expect.stringMatching(/Card\.d\.ts and card\.d\.ts, which macOS and Windows see as one file$/),
        }),
      ]);
    });
  });
});

describe('mf-build on a type-only module of another script kind beside a component', () => {
  const frameworks = ['react', 'vue'] as const;
  const cardTitle = 'export interface CardTitle {\n  title: string;\n}\n';

  // React only: the fixture's tsconfig sets no `jsx`, so vue-tsc rejects any .tsx module.
  it.each(['react'] as const)('writes card.tsx as card.d.ts: a name-clash in the %s build', async (framework) => {
    const edits = [
      {file: 'src/Card.front', content: typedCard('./card.js')},
      {file: 'src/card.tsx', content: cardTitle},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', framework, '--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual([
        expect.objectContaining({
          code: 'name-clash',
          message:
            'src/Card.front and src/card.tsx would be written as Card.d.ts and card.d.ts, which macOS and Windows see as one file',
        }),
      ]);
    });
  });

  it.each(frameworks)('writes card.mts as card.d.mts, no clash in the %s build', async (framework) => {
    const edits = [
      // Not `./card.mjs`: the floor compiler-sfc (3.5.15) finds no `.mts` behind it for `defineProps<CardTitle>()`.
      {file: 'src/Card.front', content: typedCard('./card.mts')},
      {file: 'src/card.mts', content: cardTitle},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', framework]);
      expect(run).toMatchObject({code: 0, stderr: ''});
      expect(
        readdirSync(join(root, 'dist', framework))
          .filter((file) => /^card\.d\./i.test(file))
          .sort()
      ).toEqual(['Card.d.ts', 'card.d.mts']);
    });
  });
});

describe('mf-build on a type-only JavaScript module, typed by JSDoc', () => {
  const cardTitle = '/** @typedef {{ title: string }} CardTitle */\nexport {};\n';

  /** Card.front typed from a JavaScript module in every block; Vue past `defineProps`, whose compiler reads no JSDoc. */
  function jsdocCard(specifier: string): string {
    const typeImport = `  import type { CardTitle } from '${specifier}'\n`;
    let card = typedCard(specifier);
    card = edited(
      card,
      'defineProps<CardTitle>()',
      'const props = defineProps<{ title: string }>()\n  const heading: CardTitle = props'
    );
    card = edited(card, "  import type { Snippet } from 'svelte'\n", `  import type { Snippet } from 'svelte'\n${typeImport}`);
    return edited(card, '{ title: string; children?: Snippet }', 'CardTitle & { children?: Snippet }');
  }

  const tsTitle = 'export interface CardTitle {\n  title: string;\n}\n';
  const shipped = /CardTitle\b[^}]*title: string;/;

  // Vue: the fixture sets no `jsx`, so vue-tsc rejects a .jsx module, below.
  it.each([
    ['jsx', 'react'],
    ['js', 'react'],
    ['js', 'vue'],
    ['jsx', 'svelte'],
    ['js', 'svelte'],
    ['tsx', 'svelte'],
  ] as const)('writes title.%s as title.d.ts in the %s build', async (ext, framework) => {
    const edits = [
      {file: 'src/Card.front', content: jsdocCard('./title.js')},
      {file: `src/title.${ext}`, content: ext === 'tsx' ? tsTitle : cardTitle},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', framework]);
      expect(run).toMatchObject({code: 0, stderr: ''});
      expect(readFileSync(join(root, 'dist', framework, 'title.d.ts'), 'utf8')).toMatch(shipped);
    });
  });

  it.each(['react', 'vue', 'svelte'] as const)(
    'writes a module reached through another as title.d.ts in the %s build',
    async (framework) => {
      const edits = [
        {file: 'src/Card.front', content: jsdocCard('./types.js')},
        {file: 'src/types.ts', content: "export type { CardTitle } from './title.js';\n"},
        {file: 'src/title.js', content: cardTitle},
      ];
      await withEditedLibrary(edits, async (root) => {
        const run = await runMfBuild(root, ['--framework', framework]);
        expect(run).toMatchObject({code: 0, stderr: ''});
        expect(readFileSync(join(root, 'dist', framework, 'title.d.ts'), 'utf8')).toMatch(shipped);
      });
    }
  );

  it("writes title.jsx as title.d.ts in the vue build when the library's tsconfig sets jsx", async () => {
    const options = {target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, skipLibCheck: true};
    const edits = [
      {file: 'tsconfig.json', content: JSON.stringify({compilerOptions: {...options, jsx: 'preserve'}})},
      {file: 'src/Card.front', content: jsdocCard('./title.js')},
      {file: 'src/title.jsx', content: cardTitle},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue']);
      expect(run).toMatchObject({code: 0, stderr: ''});
      expect(readFileSync(join(root, 'dist', 'vue', 'title.d.ts'), 'utf8')).toMatch(shipped);
    });
  });

  it("ignores an untyped package's JavaScript that only the listing run loads", async () => {
    const typeImport = "  import type { ReactNode } from 'react'\n";
    const card = readFileSync(join(LIBRARY_DIR, 'src', 'Card.front'), 'utf8');
    const edits = [
      {file: 'src/Card.front', content: edited(card, typeImport, `${typeImport}  import type { format } from 'flow-pkg'\n`)},
      {file: 'src/flow-pkg.d.ts', content: "declare module 'flow-pkg' {\n  export function format(value: string): string;\n}\n"},
      {file: 'node_modules/flow-pkg/package.json', content: '{"name": "flow-pkg", "type": "module", "main": "index.js"}\n'},
      // Flow syntax, which tsc rejects in a .js file.
      {file: 'node_modules/flow-pkg/index.js', content: 'export function format(value: string): string {\n  return value;\n}\n'},
    ];
    await withEditedLibrary(edits, async (root) => {
      expect(await runMfBuild(root, ['--framework', 'react'])).toMatchObject({code: 0, stderr: ''});
    });
  });

  it('reports a .jsx module as needing jsx in the vue build', async () => {
    const edits = [
      {file: 'src/Card.front', content: jsdocCard('./title.js')},
      {file: 'src/title.jsx', content: cardTitle},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual([
        expect.objectContaining({code: 'TS6142', file: 'src/Card.front', message: expect.stringContaining("'--jsx' is not set")}),
      ]);
    });
  });

  it.each([
    ['jsx', 'react'],
    ['jsx', 'vue'],
    ['js', 'vue'],
  ] as const)('writes card.%s as card.d.ts: a name-clash in the %s build', async (ext, framework) => {
    const edits = [
      {file: 'src/Card.front', content: jsdocCard('./card.js')},
      {file: `src/card.${ext}`, content: cardTitle},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', framework, '--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual([
        expect.objectContaining({
          code: 'name-clash',
          message: `src/Card.front and src/card.${ext} would be written as Card.d.ts and card.d.ts, which macOS and Windows see as one file`,
        }),
      ]);
    });
  });
});

describe("mf-build on a type-only module with a component's exact name (M6 6.1 build errors)", () => {
  const edits = [
    {file: 'src/Card.front', content: typedCard('./Card.js')},
    {file: 'src/Card.ts', content: 'export interface CardTitle {\n  title: string;\n}\n'},
  ];

  it.each(['react', 'vue'] as const)(
    'fails the %s build with a name-clash, not a lost or tsc-reported Card.d.ts',
    async (framework) => {
      await withEditedLibrary(edits, async (root) => {
        const run = await runMfBuild(root, ['--framework', framework, '--format', 'json']);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(1);
        expect(report(run.stdout).findings).toEqual([
          {
            file: 'src/Card.ts',
            code: 'name-clash',
            severity: 'error',
            message: 'src/Card.ts and src/Card.front would both be written as Card.d.ts',
            framework,
          },
        ]);
      });
    }
  );
});

describe('mf-build on a Svelte compiler error (spec 8.1: never a position in generated code)', () => {
  const bad = `<svelte lang="html">
  <script lang="ts">
    let { label }: { label: string } = $props()
    let count = $state(0)
    const doubled = $derived(count * 2)
    doubled = 3
  </script>

  <p>{label} {doubled} {count}</p>
</svelte>
`;

  // Plugin-svelte names the compiled file in its message: a space in the path once kept that name.
  it.each(['src/Bad.front', 'src/my widgets/Bad.front'])(
    'names %s and its line, and no line of the generated .svelte file',
    async (file) => {
      await withEditedLibrary([{file, content: bad}], async (root) => {
        const run = await runMfBuild(root, ['--framework', 'svelte', '--no-dts', '--format', 'json']);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(1);
        const {findings} = report(run.stdout);
        expect(findings).toHaveLength(1);
        const [finding] = findings;
        const {line, offset} = locate(bad, 'doubled = 3');
        expect(finding).toMatchObject({file, line, column: offset, severity: 'error', block: 'svelte', framework: 'svelte'});
        // The virtual `Bad.front.svelte.svelte` exists only inside the build: an agent cannot open it.
        expect(finding!.message).not.toMatch(/\.front\.svelte\.svelte/);
      });
    }
  );
});

describe('mf-build when a style preprocessor is not installed (spec 8.1: a missing tool is exit 2)', () => {
  // The repo keeps less uninstalled on purpose (spec 3.8).
  const {source} = readComponent('invalid/MissingPreprocessor.front');
  const file = 'src/MissingPreprocessor.front';

  async function expectMissing(root: string, framework: string): Promise<void> {
    for (const format of ['text', 'json']) {
      const run = await runMfBuild(root, ['--framework', framework, '--no-dts', '--format', format]);
      expect(run).toEqual({
        code: 2,
        stdout: '',
        stderr: `mf-build: buildLibrary: ${file}: <style lang="less"> needs less; install it\n`,
      });
    }
  }

  it('exits 2 with one stderr line and an empty stdout, whatever the format', async () => {
    await withEditedLibrary([{file, content: source}], (root) => expectMissing(root, 'react'));
  });

  const everyFramework = `<vue lang="vue">\n  <template><span class="pill">x</span></template>\n</vue>\n\n<svelte lang="html">\n  <span class="pill">x</span>\n</svelte>\n\n${source}`;

  it.each(['vue', 'svelte'] as const)('names the file and the package to install in the %s build', async (framework) => {
    await withEditedLibrary([{file, content: everyFramework}], (root) => expectMissing(root, framework));
  });

  // A plain `.less` file ships no CSS anyway (css-outside-style): Vite's own error stands.
  it("leaves a plain .less file to Vite's error in the library's files", async () => {
    const index = readFileSync(join(LIBRARY_DIR, 'src', 'index.ts'), 'utf8');
    const edits = [
      {file: 'src/theme.less', content: '@c: red;\n.t { color: @c; }\n'},
      {file: 'src/index.ts', content: `${index}import './theme.less';\n`},
    ];
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--no-dts', '--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual([
        expect.objectContaining({
          file: 'src/theme.less',
          code: 'vite:css',
          message: expect.stringMatching(/^Preprocessor dependency "less" not found/),
        }),
      ]);
    });
  });
});
