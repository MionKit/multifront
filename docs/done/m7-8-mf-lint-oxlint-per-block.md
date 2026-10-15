---
type: feature
spec: full-plan
status: done
created: 2026-10-15
milestone: 7
step: 7.8
---

# mf-lint: per-block files through oxlint, positions mapped back

## Problem

`.ucf` files get no lint. oxlint skips unknown extensions and has no stdin mode. 7.6 left the pieces:
`blockFile()` (`packages/language-tools/src/blocks/blockFile.ts`), `ucfFiles()` / `nearestFile()` / `parseJsonc()` /
`resolveInProject()` (`packages/language-tools/src/files.ts:27-75`), and `runCommand` (`packages/core/src/command.ts`).

Checked before planning, on the repo's oxlint 1.82.0 (`node node_modules/oxlint/bin/oxlint -c <wrapper> -f json`):

- JSON report: `{diagnostics: [{message, code: 'eslint(no-debugger)', severity, url, help, filename, labels: [{label?, span: {offset, length, line, column}}]}], number_of_files, ...}`.
  `offset` / `length` are **UTF-8 bytes** (`é` has length 2); `filename` is relative to the cwd. In `.vue` and
  `.svelte` files offsets count from the start of the file.
- A wrapper `{"extends": ["<abs path>/.oxlintrc.json"], "globals": {...}}` works. The extended config's `overrides`
  globs match relative to the **wrapper's folder** (`src/*.tsx` matched `<tmp>/src/A.tsx`, not `<tmp>/old/A.tsx`),
  so block files written at `<tmp>/<path relative to the config's folder>` match the user's globs. `**/*.tsx` matches a
  file at the top of the temp folder.
- An extended config's `ignorePatterns` are **not** applied (by path or by folder walk): `mf-lint` applies them itself,
  against the `.ucf` path.
- `overrides: [{files: [...], globals: {...}}]` in the wrapper works, so named modules can be per file.
- `oxlint ... .` from the temp folder lints every file there, dot folders and `node_modules` included: no long argument
  list (Windows caps it near 32k).
- A bad config (not JSON, `[]`, an unknown rule, a missing file): exit 1, the message on **stdout**, e.g.
  `Failed to parse oxlint configuration file.` / blank / `  x invalid config file <abs>: Failed to parse oxlint config <abs>.` / `  | key must be a string at line 1 column 3`.
- oxlint looks for `.oxlintrc.json` and `.oxlintrc.jsonc`.
- **oxlint runs no `no-unused-vars` in `.vue` and `.svelte` files** (template uses are invisible to it); `no-debugger`,
  `eqeqeq`, `no-empty` and the rest run there. `no-undef` flags Svelte runes (`$props`, `$state`) and Vue macros
  (`defineProps`) in plain `.svelte` / `.vue` files, with or without oxlint's `vue` plugin.
- The repo's `pnpm devx lint` runs plain `oxlint` from the root, nested configs on: a new `lint-format/.oxlintrc.json`
  governs that app's four `.ts` files in the repo's own lint.

## Decisions

Answers from the run-milestone orchestrator:

1. Unused variables: one in each block; `no-unused-vars` is expected only in `<react>`, as oxlint reports it on the same
   plain files. 7.8's Test line says oxlint runs no `no-unused-vars` in `.vue` / `.svelte` files.
2. Fixture counts: `lint-format/.oxfmtrc.json` `ignorePatterns` gains `Lint.ucf` and `Clean.ucf`, its `tsconfig.json`
   names `Messy.ucf`, so no earlier test changes. The 7.8 text names both edits.
3. Named-module globals are per file, through the wrapper's `overrides`; 7.8's Build step 2 says "per file".
4. oxlint's failure line: all its output lines, markers dropped, joined by spaces, paths relative; the milestone's
   "A missing tool is exit 2" bullet says so.
5. No fuzz test.
6. `lintUcf(files: SplitResult[], {root})` and `UcfLintDiagnostic` are the shipped shape; "Hands to later milestones"
   and 7.11's Build line follow.

Found while building:

- The oxlint config of `lint-format/` also ignores `Messy.ucf`: mf-fmt's fixture uses `defineProps`, `$props` and
  `$state`, which `no-undef` flags (as for plain files), so whole-app runs would carry three findings on code the lint
  tests do not own.

## Plan

### 1. Core: `CommandResult.warningsFail` (`packages/core/src/types.ts:138`, `command.ts:126`)

- `warningsFail?: boolean; // exit 1 on warnings too`.
- `runCommand` returns 1 on an error, or on a warning when `warningsFail` is set. The help's exit code line stays.

### 2. Shared ignore check (`packages/language-tools/src/files.ts`)

- `isIgnored` moves here from `format/config.ts:120`, taking `config: {file?: string; ignorePatterns: string[]}`
  (`UcfFormatConfig` still fits). `format/` imports it from `files.ts`. No behaviour change.

### 3. `lintUcf(files, {root})` (new `packages/language-tools/src/lint/index.ts`)

- `files: SplitResult[]`: each file's `splitBlocks` result (the CLI's file text; the server's in-memory text in 7.11,
  which already holds the split). A split with errors is not linted; its errors are the caller's to report.
- `root`: oxlint loads from here (the cwd, or the server's workspace folder). The project's own oxlint:
  `resolveInProject(root, 'oxlint/package.json', missing)`, its `bin.oxlint`, run as `process.execPath <bin>`.
  Missing: `oxlint is not installed in <root>; add it to devDependencies`.
- Each file's config: the nearest `.oxlintrc.json` / `.oxlintrc.jsonc` above it (`nearestFile`). A file its config's
  `ignorePatterns` ignores is skipped, as oxlint skips it. A config that does not parse ignores nothing: oxlint's own
  run then names the error. Files are grouped by config.
- Per group, sequentially, in `mkdtemp(join(tmpdir(), 'mf-lint-'))`:
  1. Each `<vue>`, `<react>`, `<svelte>` block's text at `blockFile(<relative path>, block)`, the path relative to the
     config's folder (no config: to the file's filesystem root, so paths stay unique and inside the temp folder),
     `/` separators. `<style>` blocks are skipped. A group with no block file runs no oxlint.
  2. The wrapper `.oxlintrc.json`: `extends: [<config>]` (none without one), `globals: {$style: 'readonly'}`, and one
     `overrides` entry per file with named modules (core's `moduleName()`, other than `$style`), listing that file's
     block files, `globals: {<name>: 'readonly'}`: `classes` is defined only in the file that declares it.
  3. `oxlint -c .oxlintrc.json -f json .` in the temp folder (`execFile`, `maxBuffer: Infinity`). Exit 0 or 1 with a
     JSON report: read it. Anything else (another exit, a stdout that is not its report, a bad config): throw
     `oxlint: <its output>`, stderr else stdout, `x` / `|` markers dropped, lines joined by single spaces,
     `<root>/` removed from paths.
  4. Each diagnostic maps by its `filename` (slashed) to its file and block; an unknown name throws. Primary span =
     `labels[0]`: `.ucf` offset = `contentStart` + the UTF-16 length of the block's first `offset` bytes, the same for
     `offset + length`. No label: the block's opening tag (7.6's rule).
  5. `rm(dir, {recursive: true, force: true})` in a `finally`.
- Returns `UcfLintDiagnostic[]` (new in `src/types.ts`): `{file, start, end, block: Target, code, message, severity: 'error' | 'warning' | 'advice', url?, help?}`,
  `start` / `end` UTF-16 offsets into the `.ucf` source. `LintOptions {root}`. Exported from `src/index.ts` with `lintUcf`.

### 4. The `mf-lint` bin

- `packages/language-tools/bin/mf-lint.js` like `mf-fmt.js`, through a new `#lint` entry in `package.json` `imports`
  (`source` `./src/lint/index.ts`, `default` `./dist/lint/index.js`), and `bin.mf-lint`.
- `package.json`: `oxlint` optional peer `^1.82.0` and devDependency `1.82.0` (the packages/AGENTS.md exception, as
  for oxfmt); `pnpm install` updates the lockfile.
- `MF_LINT`: summary `Lints each block of .ucf files with oxlint and the project's .oxlintrc.json.`; paths
  `Paths are .ucf files or folders; none lints every .ucf file under the current folder.`; option
  `deny-warnings: {type: 'boolean', description: 'exit 1 on warnings too'}`; example `mf-lint src/Card.ucf --format json`.
- `run(values, paths)`: load oxlint first (exit 2 when missing); `ucfFiles(paths, ignoredBy, 'lint it with oxlint')`,
  `ignoredBy` naming the cwd-relative config (`mf-lint: old/Lint.ucf is ignored by .oxlintrc.json`); `splitBlocks`
  each file: splitter errors through `findingOf`, clean splits to `lintUcf`. Each diagnostic becomes a `Finding`
  `{file, line, column, end, code, severity, message, block, framework}`: 1-based via core's `locate`, `advice` →
  `warning`, no `help` / `url`, `block` and `framework` = the block's tag. Summary `linted 5 files: 2 errors, 1 warning`
  (`..., no problems`), singular-aware like `mf-tsc`. JSON data `{files}`. `warningsFail: values['deny-warnings'] === true`.

### 5. Fixture `packages/e2e/fixtures/apps/lint-format/`

- `.oxlintrc.json`: a one-line comment, `rules: {"no-debugger": "error", "no-undef": "error"}`,
  `overrides: [{"files": ["**/*.tsx"], "rules": {"no-debugger": "warn"}}]` (a `<react>`-only severity),
  `ignorePatterns: ["old/**", "Messy.ucf"]` (built: without `Messy.ucf`, its Vue macro and Svelte runes give `no-undef`
  in every whole-app run).
- `Lint.ucf`: `<react>`, `<vue>` (`<script setup>`, no macros), `<svelte>` (no runes), each with a `debugger;` and an
  unused variable, `'é ü'` before the `debugger;` (bytes differ from UTF-16); `$style.card` in `<react>` and the
  `<svelte>` script, `classes.wide` in `<react>`; `<style module>` (`.card`) and `<style module="classes">` (`.wide`).
  Expected: `<react>` `no-unused-vars` (warning) and `no-debugger` (warning, the override); `<vue>` and `<svelte>`
  `no-debugger` (error); no `no-undef`.
- `Clean.ucf`: the three blocks and a `<style module>`, clean.
- `.oxfmtrc.json` `ignorePatterns` gains `Lint.ucf` and `Clean.ucf`; `tsconfig.json` `include` names `Messy.ucf` in
  place of `*.ucf`. The `mf-fmt` test that deletes `.oxfmtrc.json` (".editorconfig only") also deletes both from its copy.
- `pnpm devx lint` stays green with the nested config over the app's `.ts` files.

### 6. Test helpers

- `runMfLint(cwd, args, env)` in `packages/e2e/editor/lib/commands.ts`.
- `packages/e2e/editor/lib/lint.ts`: `LINT`, `CLEAN`, `LINT_SOURCE`, `fails()`, `report()`, `copyLint(root, folders)`,
  `inBlock()`, `lintFinding()` and `lintFindings(file)` (the four expected `Lint.ucf` findings).

### 7. Env registry (`scripts/lib/env.mjs`)

- Rows `TMPDIR`, `TEMP`, `TMP` (internal): the OS temp folder; the `mf-lint` test points them at a folder of its own
  to see no block file is left.

## Tests

Area Editor, `packages/e2e/editor/lint/mf-lint.spec.ts`: the real `mf-lint` bin (from `src/` via `runBin`), the real
oxlint 1.82.0, real `.ucf` fixtures on `copyApp` / `copyAppOutside` temp copies. Runs on this host and in CI's `check`
job (`pnpm devx test`, e2e project); nothing CI lacks (oxlint is a root devDependency, run as a child process).

0. Fixture: `mf-lint --format json` on the app: exactly the expected `(code, severity, block)` list; for each finding the
   `.ucf` text from `line`/`column` to `end` is the offending code (`debugger;`, `unused`), past the non-ASCII text.
   No `no-undef` for `$style` or `classes`; the `**/*.tsx` override reaches only `<react>`. Run with
   `TMPDIR`/`TEMP`/`TMP` set to a fresh folder, empty afterwards. `mf-lint Clean.ucf`: exit 0,
   `mf-lint: linted 1 file: no problems`. A copy whose `Clean.ucf` uses `classes.wide` without that module: one
   `no-undef` on `classes` there, none in `Lint.ucf`.
1. The readable output and the `--format json` document, exact (`block`, `framework`), exit 1.
2. Copies of `Lint.ucf` under `nested/`, `.hidden/`, `old/`: `mf-lint nested` reports only `nested/Lint.ucf`; no path
   reports none from `.hidden/` or `old/`; `Lint.ucf Lint.ucf` lints once.
3. `nested/.oxlintrc.json` with `no-debugger` off: `nested/Lint.ucf` has no `no-debugger`, `Lint.ucf` keeps its own.
4. `debugger;` lines removed (warnings only): exit 0, and 1 with `--deny-warnings`.
5. A copy of `components/invalid/DuplicateReact.ucf`: exactly its `duplicate-target` findings, exit 1.
6. Exit 2, stdout empty, one stderr line: an unknown option, `react.ts`, a missing path, an empty folder,
   `old/Lint.ucf`, a `copyAppOutside` copy with no oxlint (`assertNotInstalled`, `NODE_PATH` unset), an `.oxlintrc.json`
   that is not JSON (the exact `mf-lint: oxlint: ...` line; the temp folder empty here too).
7. `--help` and `-h`: exit 0, the exact help.

7.6's `mf-fmt.spec.ts` and 7.7's `svelte.spec.ts` stay green, counts unchanged.

## Docs

- `docs/architecture.md`: a `mf-lint` bullet after `mf-fmt`.
- Spec 6.1 and 8.1 already say this; no change.
- Root `README.md`: the language-tools row names `mf-lint`.
- Milestone doc: 7.8 Build/Test as shipped (`lintUcf(files: SplitResult[], {root})`, config-relative paths, per-file
  named modules, no `no-unused-vars` in `<vue>`/`<svelte>`, the fixture's oxfmt ignores and tsconfig include); the
  "A missing tool is exit 2" bullet; "Hands to later milestones"; 7.11's Build line; `- Status: done`.
- No `publicdocs/` page describes the commands yet.

## Fuzzing

None (decision 5).

## Out of scope

- `--fix`, code actions, type-aware rules, rules that follow imports across files.
- Globals for Svelte runes or Vue macros: oxlint's own behaviour on plain files; a project declares them in its config.
- Escaping glob characters in file names inside the wrapper's per-file `overrides`.
- The server side (7.11) and the upstream proposal (7.9).

## Done when

- `mf-lint.spec.ts`, `mf-fmt.spec.ts` and `svelte.spec.ts` green; `pnpm devx check` passes.
- architecture.md, README.md and the milestone doc match what shipped; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
