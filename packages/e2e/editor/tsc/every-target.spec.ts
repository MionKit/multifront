// The real `mf-tsc` checks every target of every `.ucf` file, as tsserver with our plugin sees it, one framework if asked.
import {copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {DiagnosticsError, buildTarget, createBuildContext, findingOf, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {componentPath, copyAppOutside} from '../../fixtures/index.ts';
import {runMfTsc} from '../lib/commands.ts';
import {
  BAD_PAGE,
  BROKEN,
  BROKEN_FILES,
  BROKEN_FINDINGS,
  MAIN,
  NO_SIZE,
  SVELTE_BREAKS,
  VALID,
  VUE_BREAKS,
  addFile,
  assertNotInstalled,
  bothHosts,
  editFile,
  fails,
  line,
  linkTypeScript,
  report,
  span,
  withCopy,
} from '../lib/tsc.ts';
import {offsetAt} from '../lib/tsserver.ts';

// JS `<vue>` and `<svelte>` blocks: their generators still write TypeScript-only syntax into the JS script.
const PLAIN = `<vue>
  <script setup>
  const vueLabel = 'vue'
  </script>
  <template>
    <p>{{ vueLabel }}</p>
  </template>
</vue>

<svelte>
  <script>
    const svelteLabel = 'svelte'
  </script>
  <p>{svelteLabel}</p>
</svelte>
`;

const WHOLE = `<svelte>
  <script lang="ts">
    let props = $props()
  </script>
  <p>{props.label}</p>
</svelte>
`;

const WHOLE_IMPORTER = `import type {ComponentProps} from 'svelte';
import Whole from './Whole.ucf' with {framework: 'svelte'};

export const props: ComponentProps<typeof Whole> = {label: 'any', other: 1};
`;

const VUE_PICKS = `<vue>
  <script setup lang="ts">
  import ReactBreaks from './ReactBreaks.ucf'
  </script>
  <template>
    <ReactBreaks />
  </template>
</vue>
`;

describe('mf-tsc over every target', () => {
  it('reports each broken block in its own framework, inside that block, imported or not', async () => {
    await withCopy(BROKEN, async (root) => {
      const run = await runMfTsc(root, ['--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      const {findings} = report(run.stdout);
      expect(findings).toEqual(BROKEN_FINDINGS.map(({finding}) => finding()));
      for (const {file, line, column, block} of findings.filter((finding) => finding.block)) {
        const source = readFileSync(join(root, file!), 'utf8');
        const target = splitBlocks(source, file!).targets[block as 'vue']!;
        const start = offsetAt(source, {line: line!, offset: column!});
        expect(start).toBeGreaterThanOrEqual(target.contentStart);
        expect(start).toBeLessThan(target.contentEnd);
      }
    });
  });

  it("reports a block's error when nothing imports that target", async () => {
    await withCopy(BROKEN, async (root) => {
      rmSync(join(root, 'main.ts'));
      editFile(root, 'OnlyReactExport.ucf', '<span>{{ label }}</span>', '<span>{{ label.toFixed(2) }}</span>');
      const run = await runMfTsc(root, ['OnlyReactExport.ucf', '--format', 'json']);
      const source = readFileSync(join(root, 'OnlyReactExport.ucf'), 'utf8');
      expect(report(run.stdout).findings).toEqual([
        {...VUE_BREAKS.finding('OnlyReactExport.ucf'), ...span(source, 'label.toFixed', 'toFixed'.length, 'label.'.length)},
      ]);
    });
  });

  it('gives the codes and spans tsserver with our plugin gives, file for file', async () => {
    await withCopy(BROKEN, async (root) => {
      // Our import errors inside a <vue> block too, where the target rules reject the pick.
      addFile(root, 'VuePicks.ucf', VUE_PICKS);
      const files = ['VueBreaks.ucf', 'SvelteBreaks.ucf', 'main.ts', 'VuePicks.ucf'];
      const {ours, theirs} = await bothHosts(root, files);
      expect(ours.map((findings) => findings.length)).toEqual([1, 1, 1, 1]);
      expect(theirs).toEqual(ours);
      const picks = report((await runMfTsc(root, ['VuePicks.ucf', '--format', 'json'])).stdout).findings;
      expect(picks).toEqual([
        {
          file: 'VuePicks.ucf',
          ...span(VUE_PICKS, "'./ReactBreaks.ucf'"),
          code: 'missing-target-block',
          severity: 'error',
          message: './ReactBreaks.ucf has no <vue> block; VuePicks.ucf imports it as vue',
          block: 'vue',
          framework: 'vue',
        },
      ]);
    });
  });

  it('leaves out what a tool hides on purpose, as tsserver does: a template expression under @vue-ignore', async () => {
    await withCopy(BROKEN, async (root) => {
      editFile(
        root,
        'VueBreaks.ucf',
        '<span>{{ label.toFixed(2) }}</span>',
        '<span><!-- @vue-ignore -->{{ label.toFixed(2) }}</span>'
      );
      expect(await bothHosts(root, ['VueBreaks.ucf'])).toEqual({ours: [[]], theirs: [[]]});
      expect(await runMfTsc(root, ['VueBreaks.ucf'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n',
        stderr: '',
      });
    });
  });

  it('checks a .ucf file the program reaches only through an import, in every target', async () => {
    await withCopy(BROKEN, async (root) => {
      editFile(root, 'tsconfig.json', '"include": ["*.ucf", "*.ts", "*.vue", "pages"]', '"include": ["pages"]');
      addFile(
        root,
        'pages/uses.tsx',
        'import VueBreaks from \'../VueBreaks.ucf\';\n\nexport const used = <VueBreaks label="a" />;\n'
      );
      // A pick resolves straight to the target script: its `.ucf` file joins the program.
      addFile(
        root,
        'pages/picks.ts',
        "import SvelteBreaks from '../SvelteBreaks.ucf' with {framework: 'svelte'};\n\nexport {SvelteBreaks};\n"
      );
      const run = await runMfTsc(root, ['--format', 'json']);
      expect(report(run.stdout)).toMatchObject({
        findings: [SVELTE_BREAKS.finding(), VUE_BREAKS.finding(), MAIN.finding()],
        projects: [{tsconfig: 'tsconfig.json', files: 6}],
      });
    });
  });

  it("puts a diagnostic in generated code on the block's opening tag", async () => {
    await withCopy(VALID, async (root) => {
      // The generated `declare const $style` clashes too, where no mapping leads back.
      editFile(
        root,
        'Greeting.ucf',
        "import Badge from './Badge.ucf'\n",
        "import Badge from './Badge.ucf'\n  const $style = {}\n"
      );
      const source = readFileSync(join(root, 'Greeting.ucf'), 'utf8');
      const redeclared = {
        file: 'Greeting.ucf',
        code: 'TS2451',
        severity: 'error',
        message: "Cannot redeclare block-scoped variable '$style'.",
        block: 'react',
        framework: 'react',
      } as const;
      const run = await runMfTsc(root, ['Greeting.ucf', '--format', 'json']);
      expect(report(run.stdout).findings.filter(({code}) => code === 'TS2451')).toEqual([
        {...redeclared, ...span(source, '<react>')},
        {...redeclared, ...span(source, 'const $style', '$style'.length, 'const '.length)},
      ]);
    });
  });

  it("puts one in a target script's generated code on that block's opening tag", async () => {
    await withCopy(BROKEN, async (root) => {
      // svelte2tsx declares the component under this name at the top level, beside the module script.
      const name = 'SvelteBreaks__SvelteComponent_';
      editFile(
        root,
        'SvelteBreaks.ucf',
        '<svelte>\n',
        `<svelte>\n  <script module lang="ts">\n    const ${name} = 1\n  </script>\n`
      );
      const source = readFileSync(join(root, 'SvelteBreaks.ucf'), 'utf8');
      const redeclared = {
        file: 'SvelteBreaks.ucf',
        code: 'TS2451',
        severity: 'error',
        message: `Cannot redeclare block-scoped variable '${name}'.`,
        block: 'svelte',
        framework: 'svelte',
      } as const;
      const run = await runMfTsc(root, ['SvelteBreaks.ucf', '--format', 'json']);
      expect(report(run.stdout).findings.filter(({code}) => code === 'TS2451')).toEqual([
        {...redeclared, ...span(source, '<svelte>')},
        {...redeclared, ...span(source, `const ${name}`, name.length, 'const '.length)},
      ]);
    });
  });

  it("leaves out the generators' own unused helpers, which strict unused options would flag", async () => {
    await withCopy(VALID, async (root) => {
      editFile(
        root,
        'tsconfig.json',
        '"strict": true,',
        '"strict": true,\n    "noUnusedLocals": true,\n    "noUnusedParameters": true,'
      );
      expect(await runMfTsc(root)).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 5 files with tsconfig.json: no errors\n',
        stderr: '',
      });
    });
  });

  it("leaves out the TypeScript-only syntax a generator writes into a JS block's script, never the user's", async () => {
    await withCopy(VALID, async (root) => {
      addFile(root, 'Plain.ucf', PLAIN);
      expect(await runMfTsc(root, ['Plain.ucf'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n',
        stderr: '',
      });
      editFile(root, 'Plain.ucf', 'const vueLabel = ', 'const vueLabel: string = ');
      editFile(root, 'Plain.ucf', 'const svelteLabel = ', 'const svelteLabel: string = ');
      const source = readFileSync(join(root, 'Plain.ucf'), 'utf8');
      const annotation = (needle: string, framework: 'vue' | 'svelte'): Finding => ({
        file: 'Plain.ucf',
        ...span(source, needle, 'string'.length, needle.indexOf('string')),
        code: 'TS8010',
        severity: 'error',
        message: 'Type annotations can only be used in TypeScript files.',
        block: framework,
        framework,
      });
      const run = await runMfTsc(root, ['Plain.ucf', '--format', 'json']);
      expect(report(run.stdout).findings).toEqual([
        annotation('vueLabel: string', 'vue'),
        annotation('svelteLabel: string', 'svelte'),
      ]);
    });
  });

  it('types an unannotated `let props = $props()` as svelte2tsx means to, open to any prop, in TS and JS', async () => {
    await withCopy(VALID, async (root) => {
      addFile(root, 'Whole.ucf', WHOLE);
      addFile(root, 'whole.ts', WHOLE_IMPORTER);
      expect(await runMfTsc(root, ['Whole.ucf', 'whole.ts'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 2 files with tsconfig.json: no errors\n',
        stderr: '',
      });
      // A JS block's JSDoc names the same type, which `checkJs` resolves.
      addFile(root, 'WholeJs.ucf', WHOLE.replace(' lang="ts"', ''));
      editFile(root, 'tsconfig.json', '"strict": true,', '"strict": true,\n    "allowJs": true,\n    "checkJs": true,');
      expect(await runMfTsc(root, ['WholeJs.ucf'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n',
        stderr: '',
      });
    });
  });

  it('types attribute text holding a backtick or a backslash, which svelte2tsx writes into a template literal', async () => {
    await withCopy(VALID, async (root) => {
      copyFileSync(componentPath('svelte/root-props/Merges.ucf'), join(root, 'Merges.ucf'));
      addFile(root, 'Escapes.ucf', '<svelte>\n  <p title="C:\\users" data-tick="`">x</p>\n</svelte>\n');
      expect(await runMfTsc(root, ['Merges.ucf', 'Escapes.ucf'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 2 files with tsconfig.json: no errors\n',
        stderr: '',
      });
    });
  });

  it("reports <svelte> markup Svelte cannot parse with the build's code", async () => {
    await withCopy(BROKEN, async (root) => {
      copyFileSync(componentPath('svelte/errors/UnclosedBrace.ucf'), join(root, 'UnclosedBrace.ucf'));
      const file = join(root, 'UnclosedBrace.ucf');
      const split = splitBlocks(readFileSync(file, 'utf8'), file);
      const ctx = await createBuildContext(split, {root, compiler: loadVueCompiler(root), production: false});
      const built = (() => {
        try {
          buildTarget(split, ctx, 'svelte');
        } catch (err) {
          if (err instanceof DiagnosticsError) return err.diagnostics;
        }
        throw new Error('the build took markup Svelte cannot parse');
      })();
      expect(built.map(({code}) => code)).toEqual(['svelte-parse-error']);
      const run = await runMfTsc(root, ['UnclosedBrace.ucf', '--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual(
        built.map((error) => ({...findingOf(error, split), file: 'UnclosedBrace.ucf', framework: 'svelte'}))
      );
    });
  });
});

describe('mf-tsc --framework', () => {
  it('checks one framework of one file', async () => {
    await withCopy(BROKEN, async (root) => {
      const run = await runMfTsc(root, ['SvelteBreaks.ucf', '--framework', 'svelte', '--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout)).toEqual({
        findings: [SVELTE_BREAKS.finding()],
        errorCount: 1,
        warningCount: 0,
        projects: [{tsconfig: 'tsconfig.json', files: 1}],
      });
      expect(await runMfTsc(root, ['SvelteBreaks.ucf', '--framework', 'react'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n',
        stderr: '',
      });
      const twice = await runMfTsc(root, [
        'SvelteBreaks.ucf',
        '--framework',
        'svelte',
        '--framework',
        'svelte',
        '--format',
        'json',
      ]);
      expect(report(twice.stdout).findings).toEqual([SVELTE_BREAKS.finding()]);
      expect(await runMfTsc(root, ['VueBreaks.ucf', '--framework', 'vue', '--framework', 'svelte'])).toEqual({
        code: 1,
        stdout: `${line(VUE_BREAKS.finding())}\nmf-tsc: checked 1 file with tsconfig.json: 1 error\n`,
        stderr: '',
      });
    });
  });

  it('checks every other file as usual, and skips the .ucf files with none of those blocks', async () => {
    await withCopy(BROKEN, async (root) => {
      expect(await runMfTsc(root, ['pages', '--framework', 'svelte'])).toEqual({
        code: 1,
        stdout: `${line(MAIN.finding())}\nmf-tsc: checked 1 file with tsconfig.json: 1 error\n`,
        stderr: '',
      });
      // ReactBreaks.ucf and Title.ucf have no <svelte> block.
      const lines = [BAD_PAGE, SVELTE_BREAKS, NO_SIZE, MAIN].map(({finding}) => `${line(finding())}\n`).join('');
      expect(await runMfTsc(root, ['--framework', 'svelte'])).toEqual({
        code: 1,
        stdout: `${lines}mf-tsc: checked ${BROKEN_FILES - 2} files with tsconfig.json: 4 errors\n`,
        stderr: '',
      });
    });
  });

  it('names a file with none of those blocks, an unknown framework and a path left with no file', async () => {
    await withCopy(BROKEN, async (root) => {
      expect(await runMfTsc(root, ['ReactBreaks.ucf', '--framework', 'svelte'])).toEqual(
        fails('ReactBreaks.ucf has no <svelte> block')
      );
      expect(await runMfTsc(root, ['ReactBreaks.ucf', '--framework', 'vue', '--framework', 'svelte'])).toEqual(
        fails('ReactBreaks.ucf has no <vue> or <svelte> block')
      );
      expect(await runMfTsc(root, ['--framework', 'angular'])).toEqual(
        fails("unknown framework 'angular'; use vue, react or svelte")
      );
      mkdirSync(join(root, 'react-only'));
      copyFileSync(join(root, 'ReactBreaks.ucf'), join(root, 'react-only', 'Copy.ucf'));
      editFile(root, 'tsconfig.json', '"pages"]', '"pages", "react-only"]');
      expect(await runMfTsc(root, ['react-only', '--framework', 'svelte'])).toEqual(
        fails('react-only holds no file of tsconfig.json to check in svelte')
      );
      editFile(root, 'tsconfig.json', '["*.ucf", "*.ts", "*.vue", "pages", "react-only"]', '["react-only"]');
      expect(await runMfTsc(root, ['--framework', 'vue', '--framework', 'svelte'])).toEqual(
        fails('tsconfig.json holds no file to check in vue or svelte')
      );
    });
  });

  it('needs svelte only to check a <svelte> block', async () => {
    await withCopy(
      BROKEN,
      async (root) => {
        linkTypeScript(root);
        assertNotInstalled(root, 'svelte');
        const env = {NODE_PATH: undefined};
        expect(await runMfTsc(root, ['SvelteBreaks.ucf'], env)).toEqual(
          fails(`svelte is not installed in ${realpathSync(root)}; add it to devDependencies`)
        );
        // Found but broken: its own error, not "not installed".
        addFile(root, 'node_modules/svelte/package.json', '{"name": "svelte", "exports": {"./compiler": "./compiler.js"}}\n');
        addFile(root, 'node_modules/svelte/compiler.js', "throw new Error('this svelte install is broken');\n");
        expect(await runMfTsc(root, ['SvelteBreaks.ucf'], env)).toEqual(fails('this svelte install is broken'));
        rmSync(join(root, 'node_modules', 'svelte'), {recursive: true});
        // No react types here either: the <react> block's JSX errors, but the check runs.
        const react = await runMfTsc(root, ['SvelteBreaks.ucf', '--framework', 'react'], env);
        expect({code: react.code, stderr: react.stderr}).toEqual({code: 1, stderr: ''});
      },
      copyAppOutside
    );
  });
});
