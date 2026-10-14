// M6.1 QA seams: errors of other steps and earlier milestones through the real mf-build bin, by spec 8.1's rules.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {checkBlocks, findingOf, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {LIBRARY_DIR, readComponent} from '../fixtures/index.ts';
import {locate} from '../editor/lib/tsserver.ts';
import {runMfBuild, withEditedLibrary} from './lib/library.ts';

interface Report {
  findings: Finding[];
  errorCount: number;
  warningCount: number;
  packages: unknown[];
}

function report(stdout: string): Report {
  return JSON.parse(stdout) as Report;
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
  const card = readFileSync(join(LIBRARY_DIR, 'src', 'Card.ucf'), 'utf8');
  const typed = card
    .replace(
      "  import Icon from './Icon.ucf'\n",
      "  import Icon from './Icon.ucf'\n  import type { CardTitle } from './card.js'\n"
    )
    .replace('defineProps<{ title: string }>()', 'defineProps<CardTitle>()')
    .replace(
      "  import type { ReactNode } from 'react'\n",
      "  import type { ReactNode } from 'react'\n  import type { CardTitle } from './card.js'\n"
    )
    .replace('{ title: string; children?: ReactNode }', 'CardTitle & { children?: ReactNode }');
  const edits = [
    {file: 'src/Card.ucf', content: typed},
    // Reached by type-only imports: no chunk, only tsc's card.d.ts beside Card.d.ts.
    {file: 'src/card.ts', content: 'export interface CardTitle {\n  title: string;\n}\n'},
  ];

  it.each(['react', 'vue'] as const)('fails the %s build instead of shipping Card.d.ts and card.d.ts', async (framework) => {
    expect(typed.match(/CardTitle/g)).toHaveLength(4);
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

  it('names the .ucf file, and no line of the generated .svelte file', async () => {
    await withEditedLibrary([{file: 'src/Bad.ucf', content: bad}], async (root) => {
      const run = await runMfBuild(root, ['--framework', 'svelte', '--no-dts', '--format', 'json']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(1);
      const {findings} = report(run.stdout);
      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding).toMatchObject({file: 'src/Bad.ucf', severity: 'error', block: 'svelte', framework: 'svelte'});
      // The virtual `Bad.ucf.svelte.svelte` exists only inside the build: an agent cannot open it.
      expect(finding!.message).not.toMatch(/\.ucf\.svelte\.svelte/);
      // A position, when given, is the assignment's in the file the user wrote.
      if (finding!.line !== undefined) {
        const {line, offset} = locate(bad, 'doubled = 3');
        expect({line: finding!.line, column: finding!.column}).toEqual({line, column: offset});
      }
    });
  });
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
});
