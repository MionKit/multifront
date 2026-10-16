---
type: feature
spec: full-plan
status: done
created: 2026-10-15
milestone: 7
step: 7.9
---

# A canary test for `.ucf` files in oxlint

## Problem

oxlint skips `.ucf` files. So `mf-lint` (7.8) writes each block to a temp file, runs oxlint and maps the positions
back. That costs temp files, gives no cross-file rules (`import/no-cycle`), no type-aware linting, and no support in
oxc's own VS Code extension (milestone risk "Linting a block alone"). If oxlint ever reads `.ucf` itself, `mf-lint`
should become plain oxlint, and we need a test that tells us when that happens.

Checked before planning:

- oxc `main` (2c67197, 2026-10-15): `crates/oxc_linter/src/loader/partial_loader/mod.rs:20`
  `LINT_PARTIAL_LOADER_EXTENSIONS = ["vue", "astro", "svelte"]`. `Loader::can_load` (`loader/mod.rs`) takes the known
  source types plus those, nothing else, and no config adds one. Even `oxlint -f json Lint.ucf` prints
  "No files found to lint". So per-block temp files stay the way.
- The repo's pinned oxlint 1.82.0 on `packages/e2e/fixtures/apps/lint-format/`
  (`node node_modules/oxlint/bin/oxlint -f json .`): exit 0, `number_of_files: 4` (the four `.ts` files), no
  diagnostics. With `--ignore-pattern '**/*.ucf'`: the same 4. With `--ignore-pattern '**/*.ts'`: 0, so the flag works
  and changes the count. If oxlint read `.ucf`, `Lint.ucf` and `Clean.ucf` would be counted (`Messy.ucf` is in the
  fixture's `ignorePatterns`) and `Lint.ucf`'s `debugger;` lines would be `no-debugger` errors.

## Plan (as shipped)

1. **`packages/e2e/editor/lib/format.ts`**: exports `OXLINT_DIR` (moved from `packages/e2e/editor/lint/mf-lint.spec.ts`,
   which now imports it) and `OXLINT = join(OXLINT_DIR, 'bin', 'oxlint')`, next to `OXFMT_DIR` / `OXFMT`.
2. **`packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`**: one `it`. It runs the real pinned oxlint
   (`spawnSync(process.execPath, [OXLINT, '-f', 'json', ...args], {cwd})`, cwd = `join(FIXTURES_DIR, 'apps', LINT_FORMAT)`,
   read only, no copy) twice: `.` and `--ignore-pattern '**/*.ucf' .`. Checks:
   - both runs print oxlint's JSON report (else the test shows oxlint's stderr), read for `diagnostics[].filename`
     and `number_of_files`;
   - the run linted something: `number_of_files > 0`;
   - no diagnostic's `filename` ends in `.ucf`, and both runs count the same `number_of_files`, with the message
     `oxlint now lints .ucf files (<the .ucf diagnostics>): compare its findings with mf-lint's on the same files,
     then switch mf-lint to plain oxlint`;
   - both exit 0, checked after the `.ucf` check, so the first failure on upgrade (`Lint.ucf`'s errors make oxlint
     exit 1) prints that message.
3. **Docs**: the milestone's 7.9 heading, Build and Deliverable lines, its risks, "Hands to later milestones" and Out of
   scope lines, spec 6.1 "Linting" and the milestone 7 line of `docs/plan.md` say oxlint cannot read `.ucf` (its file
   types are hard-coded) and the canary flags the day it can. `- Status: done` under 7.9.

## Decisions

- No upstream issue or PR on `oxc-project/oxc`, now or later: the user declined it. oxlint cannot be set up to lint
  `.ucf` (hard-coded file types, above), so `mf-lint`'s per-block temp files stay, and the canary watches oxlint upgrades.

## Tests

- `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts` (area Editor, Vitest project `e2e`). Real fixture, real pinned
  oxlint, no copy. Runs on this host and in CI's `check` job (`pnpm devx test`). Needs only the root devDependency
  `oxlint` 1.82.0, already installed. No new infra. Proof it can fail: with the second run leaving out `vue.ts`
  instead of the `.ucf` files, it fails with its message (`files: 4` vs `3`).
- `mf-lint.spec.ts` stays green after `OXLINT_DIR` moves.

## Fuzzing

None: no input space. The canary checks one fact about a pinned tool.

## Out of scope

- Any upstream proposal to oxc, for oxlint or oxfmt.
- Changing `mf-lint`.

## Done when

- The canary spec passes on this host and in CI, and fails with its message when oxlint lints a `.ucf` file.
- The docs no longer promise an upstream proposal.
- `pnpm devx check` passes.
- The simplify-comments pass ran on every touched source file, committed on its own.
