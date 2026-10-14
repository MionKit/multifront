// M6.1 QA seams: errors of other steps and earlier milestones through the real mf-build bin, by spec 8.1's rules.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {checkBlocks, findingOf, splitBlocks} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {LIBRARY_DIR, readComponent} from '../fixtures/index.ts';
import {locate} from '../editor/lib/tsserver.ts';
import {edited, report, runMfBuild, withEditedLibrary} from './lib/library.ts';

/** Card.ucf with both script blocks typing their props from `specifier`, by `import type` only: no chunk for it. */
function typedCard(specifier: string): string {
  const typeImport = `  import type { CardTitle } from '${specifier}'\n`;
  let card = readFileSync(join(LIBRARY_DIR, 'src', 'Card.ucf'), 'utf8');
  card = edited(card, "  import Icon from './Icon.ucf'\n", `  import Icon from './Icon.ucf'\n${typeImport}`);
  card = edited(card, 'defineProps<{ title: string }>()', 'defineProps<CardTitle>()');
  card = edited(card, "  import type { ReactNode } from 'react'\n", `  import type { ReactNode } from 'react'\n${typeImport}`);
  return edited(card, '{ title: string; children?: ReactNode }', 'CardTitle & { children?: ReactNode }');
}

describe('mf-build on a vue-only-style component (6.1.4 through 6.1.5)', () => {
  const {source} = readComponent('invalid/VueOnlyStyle.ucf');
  const edits = [{file: 'src/VueOnlyStyle.ucf', content: source}];

  it.each(['react', 'svelte'] as const)(
    'prints every v-bind() and :slotted() spot at its .ucf position in the %s build, exit 1',
    async (framework) => {
      await withEditedLibrary(edits, async (root) => {
        const split = splitBlocks(source, join(root, 'src', 'VueOnlyStyle.ucf'));
        const expected = checkBlocks(split)
          .filter(({code}) => code === 'vue-only-style')
          .map((diagnostic) => ({...findingOf(diagnostic, split), file: 'src/VueOnlyStyle.ucf', framework}));
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
          ({line, column, message}) => `src/VueOnlyStyle.ucf:${line}:${column}: error vue-only-style (${framework}): ${message}\n`
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
    {file: 'src/Card.ucf', content: typedCard('./card.js')},
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

describe("mf-build on a type-only module with a component's exact name (M6 6.1 build errors)", () => {
  const edits = [
    {file: 'src/Card.ucf', content: typedCard('./Card.js')},
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
            message: 'src/Card.ts and src/Card.ucf would both be written as Card.d.ts',
            framework,
          },
        ]);
      });
    }
  );
});

describe('mf-build on a Svelte compiler error (spec 8.1: never a position in generated code)', () => {
  const bad = `<svelte>
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
  it.each(['src/Bad.ucf', 'src/my widgets/Bad.ucf'])(
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
        // The virtual `Bad.ucf.svelte.svelte` exists only inside the build: an agent cannot open it.
        expect(finding!.message).not.toMatch(/\.ucf\.svelte\.svelte/);
      });
    }
  );
});

describe('mf-build when a style preprocessor is not installed (spec 8.1: a missing tool is exit 2)', () => {
  // The repo keeps less uninstalled on purpose (spec 3.8).
  const lessy = `<react>
  export default function Lessy() {
    return <div className="a">x</div>
  }
</react>

<style lang="less">
@c: red;
.a { color: @c; }
</style>
`;

  it('exits 2 with one stderr line and an empty stdout, whatever the format', async () => {
    await withEditedLibrary([{file: 'src/Lessy.ucf', content: lessy}], async (root) => {
      const run = await runMfBuild(root, ['--framework', 'react', '--no-dts', '--format', 'json']);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^mf-build: .*less.*\n$/);
    });
  });

  const everyFramework = `<vue>
  <template><div class="a">x</div></template>
</vue>

<svelte>
  <div class="a">x</div>
</svelte>

${lessy}`;

  it.each(['react', 'vue', 'svelte'] as const)('names the file and the package to install in the %s build', async (framework) => {
    await withEditedLibrary([{file: 'src/Lessy.ucf', content: everyFramework}], async (root) => {
      for (const format of ['text', 'json']) {
        const run = await runMfBuild(root, ['--framework', framework, '--no-dts', '--format', format]);
        expect(run).toEqual({
          code: 2,
          stdout: '',
          stderr: 'mf-build: buildLibrary: src/Lessy.ucf: <style lang="less"> needs less; install it\n',
        });
      }
    });
  });
});
