// The real `mf-lint` on copies of `lint-format/`: each block through the real oxlint, findings at their `.ucf` text.
import {mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findingOf, splitBlocks} from '@multifront/core';
import type {Finding, Target} from '@multifront/core';
import {lintUcf} from '@multifront/language-tools';
import {describe, expect, it, onTestFinished} from 'vitest';
import {FIXTURES_DIR, copyAppOutside, readComponent} from '../../fixtures/index.ts';
import {runMfLint} from '../lib/commands.ts';
import type {BinReport} from '../lib/commands.ts';
import {LINT_FORMAT, copyInto, read} from '../lib/format.ts';
import {assertNotInstalled, editFile, line, withCopy} from '../lib/tsc.ts';
import {E2E_DIR, offsetAt, tsLocation} from '../lib/tsserver.ts';

const LINT = 'Lint.ucf';
const CLEAN = 'Clean.ucf';
const UNUSED = "Variable 'unused' is declared but never used. Unused variables should start with a '_'.";
const DEBUGGER = '`debugger` statement is not allowed';
const LINT_SOURCE = read(join(FIXTURES_DIR, 'apps', LINT_FORMAT), LINT);
const OXLINT_DIR = join(E2E_DIR, '..', '..', 'node_modules', 'oxlint');
const BAD_CONFIG = (config: string) =>
  `oxlint: Failed to parse oxlint configuration file. invalid config file ${config}: ` +
  `Failed to parse oxlint config ${config}. key must be a string at line 1 column 3`;

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

const report = (stdout: string) => JSON.parse(stdout) as BinReport<{files: number}>;
const fails = (message: string) => ({code: 2, stdout: '', stderr: `mf-lint: ${message}\n`});

/** A finding on `needle` inside the `tag` block of `source`. */
function lintFinding(
  file: string,
  tag: Target,
  needle: string,
  code: string,
  severity: Finding['severity'],
  message: string,
  source = LINT_SOURCE
): Finding {
  const block = splitBlocks(source, file).blocks.find(({type}) => type === tag)!;
  const start = block.contentStart + block.content.indexOf(needle);
  const [from, to] = [tsLocation(source, start), tsLocation(source, start + needle.length)];
  const at = {line: from.line, column: from.offset, end: {line: to.line, column: to.offset}};
  return {file, ...at, code, severity, message, block: tag, framework: tag};
}

/** What the fixture config reports on `Lint.ucf`: oxlint runs no `no-unused-vars` in `.vue` or `.svelte` files. */
function lintFindings(file = LINT): Finding[] {
  return [
    lintFinding(file, 'react', 'unused', 'eslint(no-unused-vars)', 'warning', UNUSED),
    lintFinding(file, 'react', 'debugger;', 'eslint(no-debugger)', 'warning', DEBUGGER),
    lintFinding(file, 'vue', 'debugger;', 'eslint(no-debugger)', 'error', DEBUGGER),
    lintFinding(file, 'svelte', 'debugger;', 'eslint(no-debugger)', 'error', DEBUGGER),
  ];
}

/** The OS temp folder of one run, removed after the test. */
function ownTemp(): {env: NodeJS.ProcessEnv; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'mf-lint-spec-'));
  onTestFinished(() => rmSync(dir, {recursive: true, force: true}));
  return {dir, env: {TMPDIR: dir, TEMP: dir, TMP: dir}};
}

const text = (source: string, {line, column, end}: Finding) =>
  source.slice(offsetAt(source, {line: line!, offset: column!}), offsetAt(source, {line: end!.line, offset: end!.column}));

describe('mf-lint on the fixture', () => {
  it('reports the rules of each target block at their own text, past text that is not ASCII, and leaves no temp file', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const {dir, env} = ownTemp();
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
      // The run's temp folder is the one the test watches: with it gone, mf-lint cannot write its block files.
      const gone = join(dir, 'gone');
      const missing = await runMfLint(root, [], {TMPDIR: gone, TEMP: gone, TMP: gone});
      expect({code: missing.code, stdout: missing.stdout}).toEqual({code: 2, stdout: ''});
      expect(missing.stderr).toContain(join(gone, 'mf-lint-'));
    });
  });

  it('finds nothing in Clean.ucf', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      expect(await runMfLint(root, [CLEAN])).toEqual(CLEAN_RUN);
    });
  });

  it('defines a named style module only in the file that declares it, whatever its path or name', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, LINT, ['[slug]', 'bare']);
      editFile(root, CLEAN, 'className={$style.card}', 'className={classes.wide}');
      editFile(root, 'bare/Lint.ucf', '<style module="classes">', '<style>');
      const run = await runMfLint(root, ['--format', 'json']);
      const undefinedClasses = (file: string) =>
        lintFinding(file, 'react', 'classes', 'eslint(no-undef)', 'error', "'classes' is not defined.", read(root, file));
      expect(report(run.stdout).findings).toEqual([
        undefinedClasses(CLEAN),
        ...lintFindings(),
        ...lintFindings('[slug]/Lint.ucf'),
        ...lintFindings('bare/Lint.ucf').slice(0, 2),
        undefinedClasses('bare/Lint.ucf'),
        ...lintFindings('bare/Lint.ucf').slice(2),
      ]);
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

describe('lintUcf', () => {
  it("gives oxlint's diagnostics with their url and help, in .ucf offsets, for a file named relative to the root", async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const diagnostics = (await lintUcf([splitBlocks(LINT_SOURCE, LINT)], root)).sort((one, other) => one.start - other.start);
      const shown = diagnostics.map(({file, start, end, block, code, severity}) => [
        file,
        LINT_SOURCE.slice(start, end),
        block,
        code,
        severity,
      ]);
      expect(shown).toEqual([
        [LINT, 'unused', 'react', 'eslint(no-unused-vars)', 'warning'],
        [LINT, 'debugger;', 'react', 'eslint(no-debugger)', 'warning'],
        [LINT, 'debugger;', 'vue', 'eslint(no-debugger)', 'error'],
        [LINT, 'debugger;', 'svelte', 'eslint(no-debugger)', 'error'],
      ]);
      for (const {url, help, code} of diagnostics) {
        expect(url).toBe(`https://oxc.rs/docs/guide/usage/linter/rules/eslint/${code.slice('eslint('.length, -1)}.html`);
        expect(help).toBeTruthy();
      }
    });
  });
});

describe('mf-lint on one file or one folder', () => {
  it('lints only the named file or the files below the named folder, never a dot folder or an ignored one', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, LINT, ['nested', '.hidden', 'old']);
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

  it('lints each file by the .oxlintrc.json or .oxlintrc.jsonc nearest above it, inheriting nothing from the one above', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, LINT, ['nested', 'other']);
      writeFileSync(join(root, 'nested', '.oxlintrc.json'), '{"rules": {"no-debugger": "off"}}\n');
      writeFileSync(join(root, 'other', '.oxlintrc.jsonc'), '{\n  "rules": {"no-debugger": "off"}, // like nested/\n}\n');
      const {findings} = report((await runMfLint(root, ['--format', 'json'])).stdout);
      expect(findings).toEqual([...lintFindings(), lintFindings('nested/Lint.ucf')[0]!, lintFindings('other/Lint.ucf')[0]!]);
    });
  });

  it("lints with oxlint's defaults when no config is above the file", async () => {
    await withCopy(
      LINT_FORMAT,
      async (root) => {
        mkdirSync(join(root, 'node_modules'));
        symlinkSync(realpathSync(OXLINT_DIR), join(root, 'node_modules', 'oxlint'), 'junction');
        rmSync(join(root, '.oxlintrc.json'));
        const {findings} = report((await runMfLint(root, [LINT, '--format', 'json'])).stdout);
        // oxlint's default `correctness` rules warn; `no-undef` is off.
        expect(findings).toEqual(lintFindings().map((finding) => ({...finding, severity: 'warning'})));
      },
      copyAppOutside
    );
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
      copyInto(root, LINT, ['old']);
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

  it("gives oxlint's own message for an .oxlintrc.json that is not JSON, its path relative, and leaves no temp file", async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      writeFileSync(join(root, '.oxlintrc.json'), '{ bad\n');
      copyInto(root, LINT, ['nested']);
      const {dir, env} = ownTemp();
      expect(await runMfLint(root, [], env)).toEqual(fails(BAD_CONFIG('.oxlintrc.json')));
      expect(await runMfLint(join(root, 'nested'), [], env)).toEqual(fails(BAD_CONFIG('../.oxlintrc.json')));
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it('names ignorePatterns that are not a list, as oxlint reads them', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, LINT, ['old']);
      writeFileSync(join(root, '.oxlintrc.json'), '{"ignorePatterns": "old/**"}\n');
      expect(await runMfLint(root, ['old/Lint.ucf'])).toEqual(
        fails(
          'oxlint: Failed to parse oxlint configuration file. invalid config file .oxlintrc.json: ' +
            'Failed to parse config with error Error("invalid type: string \\"old/**\\", expected a sequence", line: 0, column: 0)'
        )
      );
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
