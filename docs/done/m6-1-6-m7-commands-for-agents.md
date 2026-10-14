---
type: docs
spec: full-plan
status: done
created: 2026-10-14
milestone: 6.1
step: 6.1.6
---

# Milestone 7 plans its commands for agents

## Problem

`docs/milestones/m7-full-editor-support.md` plans `mf-tsc`, `mf-lint` and `mf-fmt` the old way:

- 7.1: `mf-tsc` runs Volar's `runTsc` (the real `tsc` CLI, patched). "Output and exit codes are the same as `tsc`":
  `file(line,col): error TSxxxx`, no JSON, no end position, exit codes that cannot tell findings from bad usage, and
  no way to check one file (`tsc a.ts` drops the tsconfig; `tsc -p tsconfig.json a.ts` fails with TS5042).
- 7.8: `mf-lint --format default|json` keeps oxlint's JSON shape, not the shared `Finding`.
- 7.6: `mf-fmt` has no output, codes, help or exit 2 rules.
- No step says how to check one file or a folder, or one framework of one file. No speed measure.

6.1.5 shipped the rules (spec 8.1) and the runner (`runCommand`, `findingOf`, `Finding` in `@multifront/core`);
`runCommand` takes no paths yet. This step rewrites M7 so all three commands follow them from their first line.

## Decisions

Answers from the run-milestone orchestrator:

1. tsconfig lookup: the nearest `tsconfig.json` above each path (rule 2: Vue's language tools, like tsserver, find the
   nearest tsconfig per file; `vue-tsc` takes no paths). Matches `mf-fmt` / `mf-lint` finding their nearest config.
2. Reuse between runs: first conditional (added in 7.12 if its timing rule fired), then reversed after review: dropped,
   and listed under M7's Out of scope next to `--watch`. Rule 3, scope creep loses: build info keeps the diagnostics
   of unchanged files and still parses every file, so it cannot speed up the one-file check that would trigger it.
   Step 6.1.6's text changes to match.
3. `mf-tsc` drops `runTsc` for `proxyCreateProgram` (rule 1: spec 8.1 covers every multifront command; the `tsc` CLI
   cannot print `Finding`s). The TypeScript 7 risk line stays as planned.
4. tsconfig `references` (after review): `mf-tsc` follows them as tsserver does. A file goes to the referenced project
   that holds it; with no path, every referenced project is checked; a file no project holds stays exit 2 (rule 2:
   Vue's language tools and tsserver resolve a file to the referenced project that owns it, and `vue-tsc -b` builds
   the references). So a create-vite / create-vue root (`"files": []` plus `references`) works. 7.1 has a test row.

Settled by the docs:

1. **One file in `mf-tsc`:** load the tsconfig and build the whole program as `tsc` does, then ask TypeScript for
   the diagnostics of the given files only (syntactic + semantic per given file, plus the program's global and
   options diagnostics), as tsserver does for one open file. "Check only them" (given files as `rootNames`) loses
   the tsconfig's other files (`env.d.ts`, globals) and gives false errors; "report only them" is no faster.
   Measured on `packages/vite` (493 program files): program creation about 1.0 s, checking every file 1.6 to 1.8 s,
   one file 0.4 to 0.6 s.
2. **No emit, no `tsc` flags.** `mf-tsc` builds its program with `proxyCreateProgram(ts, ts.createProgram, ...)`
   from `@volar/typescript` (already a dependency), our language plugin and `resolveUcfImport`. The tsconfig's emit
   options are ignored; the old "an emit flag is an error" rule goes.
3. **Config errors are exit 2** (spec 8.1, "bad config"): reading the tsconfig fails (missing, bad JSON, unknown
   option, TS18003) → one stderr line, `mf-tsc: tsconfig.json:3:5: error TS5023: Unknown compiler option 'foo'.`,
   plus ` (and N more)`. The program's global and options diagnostics (TS2688) are findings with no file, exit 1,
   as in `mf-build`.
4. **Which tsconfig:** `-p, --project <file>`, else the nearest `tsconfig.json` above each file (`ts.findConfigFile`,
   `references` followed, orchestrator decision 4), else above the current folder. A folder also takes every
   `tsconfig.json` below it; each file goes to the nearest project holding it. One program per project. A file with
   none, or held by no project, is exit 2: `mf-tsc: src/Foo.ucf is not part of tsconfig.json; add it to "include"
   or pass -p`. Summary with several: `checked 5 files with 2 tsconfigs: ...`.
5. **Paths:** a file or a folder (its files below it, `node_modules` and dot folders left out), merged into one file
   set; none = the whole project (`mf-tsc`) or every `.ucf` file under the current folder (`mf-fmt`, `mf-lint`), as
   spec 8.1 now says. Exit 2: a missing path (`runCommand` checks it), a path with no file to check, and in `mf-fmt`
   / `mf-lint` a non-`.ucf` file or a named file the config's `ignorePatterns` excludes. One walker,
   `ucfFiles(paths, ignored)` in `packages/language-tools/src/files.ts` (7.6), reused by 7.8. Files are grouped by
   their nearest config: one program, oxlint run or oxfmt config per group; no config means the tool's defaults.
6. **One framework:** `mf-tsc --framework <name>` (repeatable, as `mf-build`) limits `.ucf` checks to those
   frameworks' scripts (the file's own for `react`, `MAIN_SCRIPT_TARGET`; `targetScriptName(file, target)` for the
   others). Other files are checked as usual; a `.ucf` file under a folder without those blocks is skipped, a named
   one is exit 2 (`has no <svelte> block`). A bad value is exit 2.
7. **mf-lint keeps the shared shape** (spec 8.1, "One finding shape"): oxlint's `code`, `message`, severity
   (`advice` → `warning`), position, `block` / `framework` = the block tag. oxlint's `help` and `url` stay out of
   the CLI output; `lintUcf` returns oxlint's diagnostics in `.ucf` offsets with them, for the server (7.11).
8. **New core codes:** `unformatted` (`mf-fmt --check`), `format-error` (oxfmt errors for a block; its `OxcError` has
   no code). A `.ucf` file whose blocks do not split gives core's codes through `findingOf` in all three commands.
9. **A missing tool is exit 2:** `typescript`, `oxlint` or `oxfmt` not loadable from the project, or oxlint exiting
   other than 0 / 1 or printing a stdout that is not its JSON report (oxlint exits 1 on a bad config too).
10. **runCommand grows in M7:** `CommandSpec.paths` (printed as the help's last summary line; `runCommand` checks each
    path exists) and `short` picked from node's `ParseArgsOptionDescriptor` (`help` gets `short: 'h'`, the two
    hard-coded `-h` branches go; core exports `CommandOption`) in 7.1, `CommandResult.warningsFail` in 7.8 (spec 8.1's
    exit 1 lists it). `tscFinding` stays private to `tsc/index.ts`. `formatUcf` returns `{text, findings}`.
11. **Speed:** 7.12's gate prints timings (median of 5 fresh runs; `mf-tsc` on one file, one folder, all fixtures;
    `mf-lint` on one file, all fixtures), no time assertion; numbers go in the M7 doc. No reuse (orchestrator
    decision 2). The gate's temp copy under `.tmp/` gets its own `.oxlintrc.json` (the repo config ignores
    `**/.tmp/**`).
12. **`volar-service-html`** (7.4) is a runtime dependency of `@multifront/language-tools`, beside
    `volar-service-css`, not a root devDependency.

## Plan

### 1. `docs/milestones/m7-full-editor-support.md`

- Goal: a bullet on the command rules and one-file checks.
- New `### Decision: every command follows the command rules`: shared rules, then per command (`mf-tsc` decisions
  1 to 6, `mf-fmt`, `mf-lint` decision 7), readable line and summary examples, JSON data, exact help texts, speed
  (decision 11).
- Needs: "From M6.1" (`Finding`, `findingOf`, `runCommand`, `CommandSpec`, `CommandOption`, `CommandResult`,
  `CommandValues`; `mf-build` and `library-cli.spec.ts` as the model; Svelte root `class` / `style` types).
  `@volar/typescript` leaves the new devDependencies list; `volar-service-html` becomes a runtime dependency.
- 7.1: `runCommand` + `proxyCreateProgram`, a private `tscFinding()`, paths and `short`. Tests: whole project, JSON
  exact, one file / one folder (`types-broken/pages/main.tsx`, a `node_modules` file left out, a file named twice),
  from the repo root, with `-p`, two tsconfigs in one run, a references-only root, TS2688 with no file, a splitter
  error, exit 2 cases (no tsconfig, no file to check, ` (and 1 more)`, no typescript), `--help`.
- 7.2: `--framework` and its rows (a named file without the block, a folder's `.ts` file still checked). 7.3: a
  `.vue` path, help names `.vue`.
- 7.6: `mf-fmt` on `runCommand`, `ucfFiles`, codes, missing oxfmt, nearest config; test rows 5 to 11 (exact
  `--check` and write-mode output, dot folders, `ignorePatterns`, nested config, a splitter error, exit 2 cases).
- 7.8: shared shape, `--format text|json`, `--deny-warnings` through `warningsFail`, one oxlint run per config
  group; test rows 1 to 7 (the same rules as 7.6).
- 7.11: parity on `mf-lint --format json` fields. 7.12: gate in JSON, timings, `.tmp` config, consumer bins `--help`
  and an unknown option.
- Exit test, Hands to later milestones, Risks (`runTsc` risk rewritten, one-file cost), Out of scope (`--watch`,
  reuse between runs).

### 2. `docs/spec.md`

- 5 "Where it runs": `mf-tsc [paths…]` and its options (`references` followed).
- 6.1: `mf-fmt [--check] [paths…]`, `mf-lint [--deny-warnings] [paths…]`, both follow 8.1.
- 8.1: a "One file or folder" bullet (what no path means per command, every exit 2 path case); exit 1 also on
  warnings when an option asks (`mf-lint --deny-warnings`).

### 3. `docs/plan.md`

Milestone 7: one line on the command rules.

### 4. `docs/milestones/m6.1-before-full-editor.md`

`- Status: done` on 6.1.6; the "One-file `mf-tsc`" risk settled; 6.1.6's speed line says reuse is out of scope.

## Tests

None new (docs only); `pnpm devx check` stays green.

## Docs

The step is docs: the M7 document, `docs/spec.md` (5, 6.1, 8.1), `docs/plan.md` (milestone 7) and the 6.1 milestone
document, as the Plan says. `docs/architecture.md` and `publicdocs/` unchanged: nothing is built yet.

## Out of scope

Building any of it (M7). Re-checking M2 to M6 names in the M7 doc that this step does not touch.

## Done when

- The docs above are updated, `pnpm devx check` is green, this spec is in `docs/done/`.
