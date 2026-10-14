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
2. Reuse between runs: conditional, added in 7.12 only if its timing rule fires, and only through the tsconfig's own
   `incremental` (rule 1: the step says "reuse between runs ... if one file is slow").
3. `mf-tsc` drops `runTsc` for `proxyCreateProgram` (rule 1: spec 8.1 covers every multifront command; the `tsc` CLI
   cannot print `Finding`s). The TypeScript 7 risk line stays as planned.

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
4. **Which tsconfig:** `-p, --project <file>`, else the nearest `tsconfig.json` above each path
   (`ts.findConfigFile`, `references` not followed), else above the current folder. One program per tsconfig. A path
   with none, or not a file of its program, is exit 2: `mf-tsc: src/Foo.ucf is not part of tsconfig.json; add it
   to "include" or pass -p`.
5. **Paths:** a file or a folder (its program files below it, `node_modules` left out); none = the whole project; a
   missing path is exit 2. `mf-fmt` / `mf-lint` take `.ucf` files and folders; another file is exit 2
   (`mf-lint: src/main.ts is not a .ucf file; lint it with oxlint`).
6. **One framework:** `mf-tsc --framework <name>` (repeatable, as `mf-build`) limits `.ucf` checks to those
   frameworks' scripts (the file's own for `react`, `MAIN_SCRIPT_TARGET`; `targetScriptName(file, target)` for the
   others). Other files are checked as usual. A bad value is exit 2.
7. **mf-lint keeps the shared shape** (spec 8.1, "One finding shape"): oxlint's `code`, `message`, severity
   (`advice` → `warning`), position, `block` / `framework` = the block tag. oxlint's `help` and `url` stay out of
   the CLI output; `lintUcf` returns oxlint's diagnostics in `.ucf` offsets with them, for the server (7.11).
8. **New core codes:** `unformatted` (`mf-fmt --check`), `format-error` (oxfmt errors for a block; its `OxcError` has
   no code). A `.ucf` file whose blocks do not split gives core's codes through `findingOf` in all three commands.
9. **A missing tool is exit 2:** `typescript`, `oxlint` or `oxfmt` not loadable from the project, or oxlint exiting
   other than 0 / 1.
10. **runCommand grows in M7:** `CommandSpec.paths` and `CommandOption.short` (7.1), `CommandResult.warningsFail`
    (7.8).
11. **Speed:** 7.12's gate prints timings (median of 5 fresh runs; `mf-tsc` on one file, one folder, all fixtures;
    `mf-lint` on one file, all fixtures), no time assertion; numbers go in the M7 doc. One `mf-tsc` file over 2 s,
    or over half the whole run → 7.12 adds reuse (orchestrator decision 2), with its test. The gate's temp copy
    under `.tmp/` gets its own `.oxlintrc.json` (the repo config ignores `**/.tmp/**`).

## Plan

### 1. `docs/milestones/m7-full-editor-support.md`

- Goal: a bullet on the command rules and one-file checks.
- New `### Decision: every command follows the command rules`: shared rules, then per command (`mf-tsc` decisions
  1 to 6, `mf-fmt`, `mf-lint` decision 7), readable line and summary examples, JSON data, exact help texts, speed
  (decision 11).
- Needs: "From M6.1" (`Finding`, `findingOf`, `runCommand`, `CommandSpec`, `CommandOption`, `CommandResult`,
  `CommandValues`; `mf-build` and `library-cli.spec.ts` as the model; Svelte root `class` / `style` types).
  `@volar/typescript` leaves the new devDependencies list.
- 7.1: `runCommand` + `proxyCreateProgram`, `tscFinding()` in `packages/language-tools/src/tsc/findings.ts`, paths
  and `short`. Tests: whole project, JSON exact, one file / one folder (`types-broken/pages/main.tsx`), from the repo
  root and with `-p`, TS2688 with no file, a splitter error, exit 2 cases, `--help`.
- 7.2: `--framework` and its rows. 7.3: a `.vue` path, help names `.vue`.
- 7.6: `mf-fmt` on `runCommand`, codes, missing oxfmt, paths; test rows 6 to 10.
- 7.8: shared shape, `--format text|json`, `--deny-warnings` through `warningsFail`; test rows.
- 7.11: parity on `mf-lint --format json` fields. 7.12: gate in JSON, timings, reuse rule, `.tmp` config, consumer
  bins `--help` and an unknown option.
- Exit test, Hands to later milestones, Risks (`runTsc` risk rewritten, one-file cost), Out of scope (`--watch`).

### 2. `docs/spec.md`

- 5 "Where it runs": `mf-tsc [paths…]` and its options.
- 6.1: `mf-fmt [--check] [paths…]`, `mf-lint [--deny-warnings] [paths…]`, both follow 8.1.
- 8.1: a "One file or folder" bullet.

### 3. `docs/plan.md`

Milestone 7: one line on the command rules.

### 4. `docs/milestones/m6.1-before-full-editor.md`

`- Status: done` on 6.1.6; the "One-file `mf-tsc`" risk settled.

## Tests

None new (docs only); `pnpm devx check` stays green.

## Out of scope

Building any of it (M7). Re-checking M2 to M6 names in the M7 doc that this step does not touch.

## Done when

- The docs above are updated, `pnpm devx check` is green, this spec is in `docs/done/`.
