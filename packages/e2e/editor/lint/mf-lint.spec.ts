// The real `mf-lint` on copies of `lint-format/`: each block through the real oxlint, findings at their `.ucf` text.
import {mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findingOf, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {copyAppOutside, readComponent} from '../../fixtures/index.ts';
import {runMfLint} from '../lib/commands.ts';
import {LINT_FORMAT, read} from '../lib/format.ts';
import {CLEAN, LINT, LINT_SOURCE, copyLint, fails, lintFinding, lintFindings, report} from '../lib/lint.ts';
import {assertNotInstalled, editFile, line, withCopy} from '../lib/tsc.ts';
import {offsetAt} from '../lib/tsserver.ts';

const HELP = `Usage: mf-lint [options] [paths...]

Lints each block of .ucf files with oxlint and the project's .oxlintrc.json.
Paths are .ucf files or folders; none lints every .ucf file under the current folder.

Options:
  --deny-warnings     exit 1 on warnings too
  --format <format>   text or json (default: text)
  -h, --help          show this help

Example:
  mf-lint src/Card.ucf --format json

Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
`;
const CLEAN_RUN = {code: 0, stdout: 'mf-lint: linted 1 file: no problems\n', stderr: ''};

// The OS temp folder of one run, which mf-lint must leave as it found it.
function ownTemp(): {env: NodeJS.ProcessEnv; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'mf-lint-spec-'));
  return {dir, env: {TMPDIR: dir, TEMP: dir, TMP: dir}};
}

const text = (source: string, {line, column, end}: Finding) =>
  source.slice(offsetAt(source, {line: line!, offset: column!}), offsetAt(source, {line: end!.line, offset: end!.column}));

describe('mf-lint on the fixture', () => {
  it('reports the rules of each target block at their own text, past text that is not ASCII, and leaves no temp file', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const {dir, env} = ownTemp();
      try {
        const run = await runMfLint(root, ['--format', 'json'], env);
        expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
        const {findings} = report(run.stdout);
        expect(findings.map(({code, severity, block}) => [code, severity, block])).toEqual([
          ['eslint(no-unused-vars)', 'warning', 'react'],
          // The config's `**/*.tsx` override reaches the <react> block only.
          ['eslint(no-debugger)', 'warning', 'react'],
          ['eslint(no-debugger)', 'error', 'vue'],
          ['eslint(no-debugger)', 'error', 'svelte'],
        ]);
        expect(findings.map((finding) => text(LINT_SOURCE, finding))).toEqual(['unused', 'debugger;', 'debugger;', 'debugger;']);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });
  });

  it('finds nothing in Clean.ucf', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      expect(await runMfLint(root, [CLEAN])).toEqual(CLEAN_RUN);
    });
  });

  it('defines a named style module only in the file that declares it', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      editFile(root, CLEAN, 'className={$style.card}', 'className={classes.wide}');
      const run = await runMfLint(root, ['--format', 'json']);
      const source = read(root, CLEAN);
      const undefinedClasses = lintFinding(
        CLEAN,
        'react',
        'classes',
        'eslint(no-undef)',
        'error',
        "'classes' is not defined.",
        source
      );
      expect(report(run.stdout).findings).toEqual([undefinedClasses, ...lintFindings()]);
    });
  });

  it('prints each finding readably, or as the exact JSON document', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const findings = lintFindings();
      expect(await runMfLint(root)).toEqual({
        code: 1,
        stdout: `${[...findings.map(line), 'mf-lint: linted 2 files: 2 errors, 2 warnings'].join('\n')}\n`,
        stderr: '',
      });
      const json = await runMfLint(root, ['--format', 'json']);
      expect(JSON.parse(json.stdout)).toEqual({findings, errorCount: 2, warningCount: 2, files: 2});
    });
  });
});

describe('mf-lint on one file or one folder', () => {
  it('lints only the named file or the files below the named folder, never a dot folder or an ignored one', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyLint(root, ['nested', '.hidden', 'old']);
      const nested = await runMfLint(root, ['nested', '--format', 'json']);
      expect(report(nested.stdout)).toEqual({
        findings: lintFindings('nested/Lint.ucf'),
        errorCount: 2,
        warningCount: 2,
        files: 1,
      });
      const all = report((await runMfLint(root, ['--format', 'json'])).stdout);
      expect(all.files).toBe(3);
      expect(all.findings).toEqual([...lintFindings(), ...lintFindings('nested/Lint.ucf')]);
      expect(report((await runMfLint(root, [LINT, LINT, '--format', 'json'])).stdout)).toMatchObject({
        files: 1,
        findings: lintFindings(),
      });
    });
  });

  it('lints each file by the .oxlintrc.json nearest above it, inheriting nothing from the one above', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyLint(root, ['nested']);
      writeFileSync(join(root, 'nested', '.oxlintrc.json'), '{"rules": {"no-debugger": "off"}}\n');
      const {findings} = report((await runMfLint(root, ['--format', 'json'])).stdout);
      expect(findings).toEqual([...lintFindings(), lintFindings('nested/Lint.ucf')[0]!]);
    });
  });
});

describe('mf-lint exit codes', () => {
  it('passes warnings, unless --deny-warnings', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      for (const tag of ['react', 'vue', 'svelte']) editFile(root, LINT, `debugger;`, `// ${tag}`);
      const summary = 'mf-lint: linted 1 file: 1 warning\n';
      const run = await runMfLint(root, [LINT]);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 0, stderr: ''});
      expect(run.stdout.endsWith(summary)).toBe(true);
      const denied = await runMfLint(root, [LINT, '--deny-warnings']);
      expect(denied).toEqual({...run, code: 1});
    });
  });

  it("reports the splitter's errors", async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const {source} = readComponent('invalid/DuplicateReact.ucf');
      const file = join(root, 'DuplicateReact.ucf');
      writeFileSync(file, source);
      const split = splitBlocks(source, file);
      expect(split.errors.map(({code}) => code)).toEqual(['duplicate-target', 'duplicate-target']);
      const run = await runMfLint(root, ['DuplicateReact.ucf', '--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout).findings).toEqual(
        split.errors.map((error) => ({...findingOf(error, split), file: 'DuplicateReact.ucf'}))
      );
    });
  });
});

describe('mf-lint that cannot run', () => {
  it('names an unknown option, a file that is not .ucf, a missing path, a folder with nothing to lint and an ignored file', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyLint(root, ['old']);
      mkdirSync(join(root, 'empty'));
      expect(await runMfLint(root, ['--nope'])).toEqual(
        fails("unknown option '--nope'; use --deny-warnings, --format or --help")
      );
      expect(await runMfLint(root, ['react.ts'])).toEqual(fails('react.ts is not a .ucf file; lint it with oxlint'));
      expect(await runMfLint(root, ['nope.ucf'])).toEqual(fails('nope.ucf does not exist'));
      expect(await runMfLint(root, ['empty'])).toEqual(fails('empty holds no .ucf file'));
      expect(await runMfLint(root, ['old'])).toEqual(fails('old holds no .ucf file'));
      expect(await runMfLint(root, ['old/Lint.ucf'])).toEqual(fails('old/Lint.ucf is ignored by .oxlintrc.json'));
    });
  });

  it("gives oxlint's own message for an .oxlintrc.json that is not JSON, and leaves no temp file", async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      writeFileSync(join(root, '.oxlintrc.json'), '{ bad\n');
      const {dir, env} = ownTemp();
      try {
        expect(await runMfLint(root, [], env)).toEqual(
          fails(
            'oxlint: Failed to parse oxlint configuration file. invalid config file .oxlintrc.json: ' +
              'Failed to parse oxlint config .oxlintrc.json. key must be a string at line 1 column 3'
          )
        );
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });
  });

  it('says when the project has no oxlint to load', async () => {
    await withCopy(
      LINT_FORMAT,
      async (root) => {
        assertNotInstalled(root, 'oxlint');
        // No global install either: Node also looks in NODE_PATH.
        expect(await runMfLint(root, [], {NODE_PATH: undefined})).toEqual(
          fails(`oxlint is not installed in ${realpathSync(root)}; add it to devDependencies`)
        );
      },
      copyAppOutside
    );
  });

  it('prints the help for --help and -h', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const help = {code: 0, stdout: HELP, stderr: ''};
      expect(await runMfLint(root, ['--help'])).toEqual(help);
      expect(await runMfLint(root, ['-h'])).toEqual(help);
    });
  });
});
