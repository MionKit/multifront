import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {mkdir, rm} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {checkBlocks, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {normalizePath} from 'vite';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, LIBRARY_DIR, copyLibrary, readComponent, removeLibrary} from '../fixtures/index.ts';
import {locate, offsetAt} from '../editor/lib/tsserver.ts';
import {edited, report, runMfBuild, withEditedLibrary} from './lib/library.ts';

const ANGULAR_CONFIG = "export default {frameworks: ['angular']};\n";
const UNKNOWN_ANGULAR = "mf-build: buildLibrary: unknown framework 'angular'; use vue, react, svelte\n";
const OPTIONS = '--root, --framework, --out-dir, --no-dts, --format or --help';
const HELP = `Usage: mf-build [options]

Builds the .ucf components of a library into one package per framework.
Reads multifront.config.ts (or .js, .mjs) in the root; options win over it.

Options:
  --root <folder>      the library folder (default: the current folder)
  --framework <name>   build only this framework: vue, react or svelte; repeat for more
  --out-dir <folder>   where the packages go, relative to the root (default: dist)
  --no-dts             write no .d.ts files
  --format <format>    text or json (default: text)
  -h, --help           show this help

Example:
  mf-build --framework react --format json

Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
`;

const read = (file: string) => readFileSync(join(LIBRARY_DIR, file), 'utf8');
const CARD = read('src/Card.ucf');
const CX = read('src/utils/cx.ts');
const INDEX = read('src/index.ts');
const SVELTE_IMPORTS = "  import type { Snippet } from 'svelte'\n  import Icon from './Icon.ucf'\n";

function filesUnder(dir: string): number {
  return readdirSync(dir, {recursive: true, withFileTypes: true}).filter((entry) => entry.isFile()).length;
}

function cardImporting(line: string): string {
  return edited(CARD, SVELTE_IMPORTS, `${SVELTE_IMPORTS}  ${line}\n`);
}

// 1-based line and column.
function positionOf(text: string, search: string): {line: number; column: number} {
  const {line, offset} = locate(text, search);
  return {line, column: offset};
}

describe('mf-build on a clean library', () => {
  it('prints one summary line', async () => {
    const root = await copyLibrary();
    try {
      const run = await runMfBuild(root);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const dist = join(root, 'dist');
      expect(readdirSync(dist).sort()).toEqual(['react', 'svelte', 'vue']);
      const count = (target: string) => filesUnder(join(dist, target));
      expect(run.stdout).toBe(
        `mf-build: built 3 packages in dist: vue ${count('vue')} files, react ${count('react')} files ` +
          `(skipped VueOnly.ucf), svelte ${count('svelte')} files (skipped Badge.ucf, VueOnly.ucf)\n`
      );
    } finally {
      await removeLibrary(root);
    }
  });

  it('prints every package with its name from multifront.config.ts under --format json', async () => {
    const root = await copyLibrary();
    try {
      const run = await runMfBuild(root, ['--format', 'json', '--no-dts']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const count = (target: string) => filesUnder(join(root, 'dist', target));
      expect(report(run.stdout)).toEqual({
        findings: [],
        errorCount: 0,
        warningCount: 0,
        packages: [
          {framework: 'vue', name: '@mf-fixture/ui-vue', outDir: 'dist/vue', files: count('vue'), skipped: []},
          {
            framework: 'react',
            name: '@mf-fixture/ui-react',
            outDir: 'dist/react',
            files: count('react'),
            skipped: ['VueOnly.ucf'],
          },
          {
            framework: 'svelte',
            name: '@mf-fixture/ui-svelte',
            outDir: 'dist/svelte',
            files: count('svelte'),
            skipped: ['Badge.ucf', 'VueOnly.ucf'],
          },
        ],
      });
    } finally {
      await removeLibrary(root);
    }
  });

  it('lets --root, --framework, --out-dir and --no-dts win over the config', async () => {
    const config = `import {defineLibrary} from '@multifront/vite';

export default defineLibrary({
  root: 'nowhere',
  frameworks: ['react'],
  outDir: 'elsewhere',
  dts: true,
  packages: {vue: {name: '@acme/cards-vue'}},
});
`;
    await withEditedLibrary([{file: 'multifront.config.ts', content: config}], async (root) => {
      const args = ['--root', root, '--framework', 'vue', '--no-dts', '--out-dir', 'out', '--format', 'json'];
      const run = await runMfBuild(FIXTURES_DIR, args);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const outDir = join(root, 'out', 'vue');
      expect(readdirSync(join(root, 'out'))).toEqual(['vue']);
      expect(existsSync(join(root, 'elsewhere'))).toBe(false);
      expect(readdirSync(outDir, {recursive: true}).filter((file) => String(file).endsWith('.d.ts'))).toEqual([]);
      const shown = normalizePath(relative(FIXTURES_DIR, outDir));
      expect(report(run.stdout).packages).toEqual([
        {framework: 'vue', name: '@acme/cards-vue', outDir: shown, files: filesUnder(outDir), skipped: []},
      ]);
    });
  });

  it('calls a config function with the build env and awaits it', async () => {
    const config = 'export default async ({command, mode}) => ({packages: {vue: {name: `@acme/${command}-${mode}`}}});\n';
    await withEditedLibrary([{file: 'multifront.config.mjs', content: config}], async (root) => {
      await rm(join(root, 'multifront.config.ts'));
      const run = await runMfBuild(root, ['--framework', 'vue', '--no-dts', '--format', 'json']);
      expect(run).toMatchObject({code: 0, stderr: ''});
      expect(report(run.stdout).packages).toEqual([expect.objectContaining({name: '@acme/build-production'})]);
    });
  });

  it('builds with the defaults when there is no config, and shows the out dir it runs in as .', async () => {
    await withEditedLibrary([], async (root) => {
      await rm(join(root, 'multifront.config.ts'));
      const dist = join(root, 'dist');
      await mkdir(dist, {recursive: true});
      const run = await runMfBuild(dist, ['--root', '..', '--framework', 'vue', '--no-dts']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const manifest = JSON.parse(readFileSync(join(dist, 'vue', 'package.json'), 'utf8')) as {name: string};
      expect(manifest.name).toBe('@mf-fixture/ui-vue');
      expect(run.stdout).toBe(`mf-build: built 1 package in .: vue ${filesUnder(join(dist, 'vue'))} files\n`);
    });
  });
});

describe('mf-build on errors in the library files', () => {
  const clash = [
    {file: 'src/card.ts', content: 'export const card = 1;\n'},
    {file: 'src/index.ts', content: `${INDEX}export {card} from './card.js';\n`},
  ];
  const clashMessage =
    'src/Card.ucf and src/card.ts would be written as Card.js and card.js, which macOS and Windows see as one file';

  it('prints a case-only clash and exits 1', async () => {
    await withEditedLibrary(clash, async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--no-dts']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(`src/Card.ucf: error name-clash (vue): ${clashMessage}\nmf-build: 1 error in the vue build\n`);
      expect(existsSync(join(root, 'dist', 'vue', 'package.json'))).toBe(false);
    });
  });

  it('prints the same clash in the shared shape under --format json', async () => {
    await withEditedLibrary(clash, async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--no-dts', '--format', 'json']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(1);
      const finding = {file: 'src/Card.ucf', code: 'name-clash', severity: 'error', message: clashMessage, framework: 'vue'};
      expect(report(run.stdout)).toEqual({findings: [finding], errorCount: 1, warningCount: 0, packages: []});
    });
  });

  it('prints every error of a .ucf file at its position in that file', async () => {
    const twice = readComponent('invalid/DuplicateReact.ucf');
    await withEditedLibrary([{file: 'src/Twice.ucf', content: twice.source}], async (root) => {
      const diagnostics = checkBlocks(splitBlocks(twice.source, join(root, 'src', 'Twice.ucf')));
      expect(diagnostics.map(({code}) => code)).toEqual(['duplicate-target', 'duplicate-target']);
      const json = await runMfBuild(root, ['--framework', 'react', '--no-dts', '--format', 'json']);
      expect(json.stderr).toBe('');
      expect(json.code).toBe(1);
      const {findings, errorCount} = report(json.stdout);
      expect(errorCount).toBe(2);
      expect(findings.map(({line, column}) => ({line, column}))).toEqual(
        diagnostics.map(({line, column}) => ({line, column: column + 1}))
      );
      for (const {file, line, column, end, block, framework, code, message} of findings) {
        expect({file, block, framework, code, message}).toEqual({
          file: 'src/Twice.ucf',
          block: 'react',
          framework: 'react',
          code: 'duplicate-target',
          message: '<react> appears more than once; keep one',
        });
        const from = offsetAt(twice.source, {line: line!, offset: column!});
        expect(twice.source.slice(from, offsetAt(twice.source, {line: end!.line, offset: end!.column}))).toBe(
          '<react lang="tsx">'
        );
      }
      const run = await runMfBuild(root, ['--framework', 'react', '--no-dts']);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(
        findings
          .map(({line, column, message}) => `src/Twice.ucf:${line}:${column}: error duplicate-target (react): ${message}\n`)
          .join('') + 'mf-build: 2 errors in the react build\n'
      );
    });
  });

  const cxLines = CX.split('\n').length;
  const cxAttribute = "import Card from '../Card.ucf' with {framework: 'vue'};\nexport const card = Card;\n";
  const templateError = readComponent('vue/TemplateError.ucf').source;
  const typeErrorCard = edited(CARD, '    return (\n', "    const count: number = 'x'\n    return (\n");
  const aliasConfig = `import {fileURLToPath} from 'node:url';
import {defineLibrary} from '@multifront/vite';

export default defineLibrary({vite: {resolve: {alias: {'~': fileURLToPath(new URL('./src', import.meta.url))}}}});
`;
  const usesVueOnly =
    '<react lang="tsx">\n  import VueOnly from \'./VueOnly.ucf\'\n\n  export default function UsesVueOnly() {\n    return <VueOnly />\n  }\n</react>\n';
  const cases: {name: string; edits: {file: string; content: string}[]; args: string[]; findings: Finding[]}[] = [
    {
      name: 'an import that is not a peer',
      edits: [{file: 'src/utils/cx.ts', content: `import leftPad from 'left-pad';\n\nexport const pad = leftPad;\n${CX}`}],
      args: ['--framework', 'react', '--no-dts'],
      findings: [
        {
          file: 'src/utils/cx.ts',
          code: 'not-a-peer',
          severity: 'error',
          message:
            '"left-pad" is imported by src/utils/cx.ts, but it is not a peer dependency of @mf-fixture/ui-react: ' +
            'a library package has peer dependencies only. Add it to packages.react.peers to keep it external.',
          framework: 'react',
        },
      ],
    },
    {
      name: 'a file outside src',
      edits: [
        {file: 'shared/tokens.ts', content: "export const accent = 'rgb(1, 2, 3)';\n"},
        {
          file: 'src/Card.ucf',
          content: CARD.replace('<react lang="tsx">\n', '<react lang="tsx">\n  import \'../shared/tokens.js\'\n'),
        },
      ],
      args: ['--framework', 'react', '--no-dts'],
      findings: [
        {
          file: 'shared/tokens.ts',
          code: 'outside-src',
          severity: 'error',
          message: 'shared/tokens.ts is outside src: a library package ships only the files of its src folder',
          framework: 'react',
        },
      ],
    },
    {
      name: 'a plain CSS file',
      edits: [
        {file: 'src/utils/cx.css', content: '.cx {\n  color: red;\n}\n'},
        {file: 'src/utils/cx.ts', content: `import './cx.css';\n\n${CX}`},
      ],
      args: ['--framework', 'react', '--no-dts'],
      findings: [
        {
          file: 'src/utils/cx.css',
          code: 'css-outside-style',
          severity: 'error',
          message: 'src/utils/cx.css is imported by src/utils/cx.ts: a library package ships CSS from .ucf <style> blocks only',
          framework: 'react',
        },
      ],
    },
    {
      name: 'a component named like styles.css',
      edits: [{file: 'src/Styles.ucf', content: read('src/Icon.ucf')}],
      args: ['--framework', 'vue', '--no-dts'],
      findings: [
        {
          file: 'src/Styles.ucf',
          code: 'name-clash',
          severity: 'error',
          message:
            'src/Styles.ucf would be written as Styles.css, which macOS and Windows see as styles.css, the name of the combined CSS file',
          framework: 'vue',
        },
      ],
    },
    {
      name: 'a plain Svelte file named like a component',
      edits: [
        {file: 'src/Plain.ucf', content: '<svelte lang="html">\n  <p>component</p>\n</svelte>\n'},
        {file: 'src/plain.svelte', content: '<p>plain</p>\n'},
        {
          file: 'src/Card.ucf',
          content: edited(
            cardImporting("import PlainFile from './plain.svelte'"),
            '{@render children?.()}',
            '{@render children?.()}\n    <PlainFile />'
          ),
        },
      ],
      args: ['--framework', 'svelte', '--no-dts'],
      findings: [
        {
          file: 'src/Plain.ucf',
          code: 'name-clash',
          severity: 'error',
          message:
            'src/Plain.ucf and src/plain.svelte would be written as Plain.svelte and plain.svelte, which macOS and Windows see as one file',
          framework: 'svelte',
        },
      ],
    },
    {
      name: 'a file named like the scope helper',
      edits: [
        {file: 'src/_ucf/scopeattrs.ts', content: "console.info('loaded');\n"},
        {file: 'src/Card.ucf', content: cardImporting("import './_ucf/scopeattrs.js'")},
      ],
      args: ['--framework', 'svelte', '--no-dts'],
      findings: [
        {
          file: 'src/_ucf/scopeattrs.ts',
          code: 'name-clash',
          severity: 'error',
          message:
            '_ucf/scopeattrs.js, which macOS and Windows see as _ucf/scopeAttrs.js, is the name of the shipped scope helper; ' +
            'rename that file in src',
          framework: 'svelte',
        },
      ],
    },
    {
      name: 'a runes module whose types are a component types',
      edits: [
        {file: 'src/icon.svelte.ts', content: 'export const iconState: {size: number} = $state({size: 16});\n'},
        {file: 'src/index.ts', content: `${INDEX}export {iconState} from './icon.svelte.js';\n`},
      ],
      args: ['--framework', 'svelte'],
      findings: [
        {
          file: 'src/Icon.ucf',
          code: 'name-clash',
          severity: 'error',
          message:
            'src/Icon.ucf and src/icon.svelte.ts would be written as Icon.svelte.d.ts and icon.svelte.d.ts, ' +
            'which macOS and Windows see as one file',
          framework: 'svelte',
        },
      ],
    },
    {
      name: 'a bare import a shipped Svelte file keeps',
      edits: [
        {file: 'multifront.config.ts', content: aliasConfig},
        {file: 'src/Card.ucf', content: cardImporting("import { cx as join } from '~/utils/cx.js'")},
      ],
      args: ['--framework', 'svelte', '--no-dts'],
      findings: [
        {
          file: 'src/Card.ucf',
          code: 'svelte-import',
          severity: 'error',
          message:
            'src/Card.ucf imports "~/utils/cx.js" in its <svelte> block: a shipped svelte file can import relative files and peers only',
          framework: 'svelte',
        },
      ],
    },
    {
      name: 'a .ucf import with no block for the framework',
      edits: [{file: 'src/UsesVueOnly.ucf', content: usesVueOnly}],
      args: ['--framework', 'react', '--no-dts'],
      findings: [
        {
          file: 'src/UsesVueOnly.ucf',
          code: 'missing-target-block',
          severity: 'error',
          message: './VueOnly.ucf has no <react> block; UsesVueOnly.ucf imports it as react',
          block: 'react',
          framework: 'react',
        },
      ],
    },
    {
      name: 'an import attribute naming a framework not built',
      edits: [{file: 'src/utils/cx.ts', content: `${CX}${cxAttribute}`}],
      args: ['--framework', 'react', '--no-dts'],
      findings: [
        {
          file: 'src/utils/cx.ts',
          line: cxLines,
          column: positionOf(cxAttribute, "'../Card.ucf'").column,
          code: 'target-not-enabled',
          severity: 'error',
          message: '../Card.ucf: framework "vue" is not enabled; use react, or add vue to the frameworks option',
          framework: 'react',
        },
      ],
    },
    {
      name: "a Vue compiler error, at Vue's position in the .ucf file",
      edits: [{file: 'src/TemplateError.ucf', content: templateError}],
      args: ['--framework', 'vue', '--no-dts'],
      findings: [
        {
          file: 'src/TemplateError.ucf',
          ...positionOf(templateError, '<span>'),
          code: 'vite:vue',
          severity: 'error',
          message: 'Element is missing end tag.',
          block: 'vue',
          framework: 'vue',
        },
      ],
    },
    {
      name: "a Vue <script> error, whose position is the script's own, with no position",
      edits: [
        {
          file: 'src/Card.ucf',
          content: CARD.replace("  import Icon from './Icon.ucf'\n", "  import Icon from './Icon.ucf' with {framework: kind}\n"),
        },
      ],
      args: ['--framework', 'vue', '--no-dts'],
      findings: [
        {
          file: 'src/Card.ucf',
          code: 'vite:vue',
          severity: 'error',
          message: '[vue/compiler-sfc] Only string literals are allowed as module attribute values. (2:49)',
          block: 'vue',
          framework: 'vue',
        },
      ],
    },
    {
      name: 'an error of a Rolldown plugin that names no module',
      edits: [{file: 'src/utils/cx.ts', content: `${CX}const kind = 'vue';\n${cxAttribute.replace("'vue'}", 'kind}')}`}],
      args: ['--framework', 'react', '--no-dts'],
      findings: [
        {
          code: 'builtin:vite-transform',
          severity: 'error',
          message: 'Only string literals are allowed as module attribute values.',
          framework: 'react',
        },
      ],
    },
    {
      name: 'type errors, positioned in a plain file only',
      edits: [
        {file: 'src/Card.ucf', content: typeErrorCard},
        {file: 'src/utils/cx.ts', content: `${CX}export const broken: number = 'x';\n`},
      ],
      args: ['--framework', 'react'],
      findings: [
        {
          file: 'src/Card.ucf',
          code: 'TS2322',
          severity: 'error',
          message: "Type 'string' is not assignable to type 'number'.",
          framework: 'react',
        },
        {
          file: 'src/utils/cx.ts',
          line: cxLines,
          column: 14,
          code: 'TS2322',
          severity: 'error',
          message: "Type 'string' is not assignable to type 'number'.",
          framework: 'react',
        },
      ],
    },
  ];

  it("keeps Vite's own error logs on stderr", async () => {
    const icon = read('src/Icon.ucf').replace('<style scoped>\n', "<style scoped>\n@import './missing.css';\n");
    await withEditedLibrary([{file: 'src/Icon.ucf', content: icon}], async (root) => {
      const run = await runMfBuild(root, ['--framework', 'vue', '--no-dts', '--format', 'json']);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('Unable to resolve `@import "./missing.css"`');
      expect(run.stderr).not.toContain('Build failed');
      expect(report(run.stdout).findings).toEqual([
        {
          file: 'src/Icon.ucf',
          code: 'vite:css',
          severity: 'error',
          // postcss's own text: Windows names the absolute path it tried, Linux the one written.
          message: expect.stringMatching(/^\[postcss\] ENOENT: no such file or directory, open '.*missing\.css'$/),
          block: 'style',
          framework: 'vue',
        },
      ]);
    });
  });

  it('prints a type error with no file, its follow-up lines joined', async () => {
    const options = '"strict": true, "module": "esnext", "moduleResolution": "bundler", "types": ["nonexistent"]';
    const tsconfig = `{"compilerOptions": {${options}}}\n`;
    await withEditedLibrary([{file: 'tsconfig.json', content: tsconfig}], async (root) => {
      const run = await runMfBuild(root, ['--framework', 'react']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(
        "error TS2688 (react): Cannot find type definition file for 'nonexistent'. The file is in the program because: " +
          "Entry point of type library 'nonexistent' specified in compilerOptions\nmf-build: 1 error in the react build\n"
      );
    });
  });

  it.each(cases)('prints $name as findings', async ({edits, args, findings}) => {
    await withEditedLibrary(edits, async (root) => {
      const run = await runMfBuild(root, [...args, '--format', 'json']);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(1);
      expect(report(run.stdout)).toEqual({findings, errorCount: findings.length, warningCount: 0, packages: []});
    });
  });
});

describe('mf-build when it cannot run', () => {
  it.each([
    {name: '.ts before .js', files: {ts: ANGULAR_CONFIG, js: 'export default 5;\n'}, error: UNKNOWN_ANGULAR},
    {name: '.js before .mjs', files: {js: ANGULAR_CONFIG, mjs: 'export default 5;\n'}, error: UNKNOWN_ANGULAR},
    {
      name: 'a config that is no object',
      files: {mjs: 'export default 5;\n'},
      error: 'mf-build: cannot load <mjs>: config must export or return an object.\n',
    },
    {
      name: 'a config with no default export',
      files: {mjs: "export const frameworks = ['vue'];\n"},
      error: 'mf-build: cannot load <mjs>: config must export or return an object.\n',
    },
    {
      name: 'a config that throws an Error',
      files: {mjs: "throw new Error('bad config');\n"},
      error: 'mf-build: cannot load <mjs>: bad config\n',
    },
    {
      name: 'a config function that returns no object',
      files: {mjs: 'export default () => 5;\n'},
      error: 'mf-build: cannot load <mjs>: config must export or return an object.\n',
    },
    {
      name: 'a config that throws a string',
      files: {mjs: "throw 'bad config';\n"},
      error: 'mf-build: cannot load <mjs>: bad config\n',
    },
    {
      name: 'frameworks as a string',
      files: {mjs: "export default {frameworks: 'vue'};\n"},
      error: 'mf-build: buildLibrary: frameworks must be an array of framework names, got "vue"\n',
    },
  ])('exits 2 on $name', async ({files, error}) => {
    const edits = Object.entries(files).map(([ext, content]) => ({file: `multifront.config.${ext}`, content}));
    await withEditedLibrary(edits, async (root) => {
      if (!('ts' in files)) await rm(join(root, 'multifront.config.ts'));
      const run = await runMfBuild(root);
      expect(run.code).toBe(2);
      expect(run.stderr).toBe(error.replace('<mjs>', join(root, 'multifront.config.mjs')));
      expect(run.stdout).toBe('');
      expect(existsSync(join(root, 'dist'))).toBe(false);
    });
  });

  it.each([
    {args: ['--outdir', 'x'], error: `mf-build: unknown option '--outdir'; use ${OPTIONS}\n`},
    {args: ['-x'], error: `mf-build: unknown option '-x'; use ${OPTIONS}\n`},
    {args: ['src'], error: "mf-build: unexpected argument 'src'; mf-build takes options only\n"},
    {args: ['--format', 'xml'], error: "mf-build: unknown format 'xml'; use text or json\n"},
    {args: ['--root'], error: "mf-build: Option '--root <value>' argument missing\n"},
    {args: ['--no-dts=yes'], error: "mf-build: Option '--no-dts' does not take an argument\n"},
    {args: ['--framework', 'vue', '--framework', 'angular', '--out-dir', 'out'], error: UNKNOWN_ANGULAR},
    {args: ['--framework', 'angular', '--format', 'json'], error: UNKNOWN_ANGULAR},
    {args: ['--format', 'json', '--outdir', 'x'], error: `mf-build: unknown option '--outdir'; use ${OPTIONS}\n`},
  ])('exits 2 on $args, stdout empty whatever the format', async ({args, error}) => {
    await withEditedLibrary([], async (root) => {
      const run = await runMfBuild(root, args);
      expect(run.code).toBe(2);
      expect(run.stderr).toBe(error);
      expect(run.stdout).toBe('');
      expect(existsSync(join(root, 'dist'))).toBe(false);
      expect(existsSync(join(root, 'out'))).toBe(false);
    });
  });

  it.each([['--help'], ['-h']])('prints the help on %s', async (flag) => {
    await withEditedLibrary([], async (root) => {
      const run = await runMfBuild(root, [flag]);
      expect(run).toEqual({code: 0, stdout: HELP, stderr: ''});
      expect(existsSync(join(root, 'dist'))).toBe(false);
    });
  });
});
