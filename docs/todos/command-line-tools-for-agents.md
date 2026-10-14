---
type: feature
spec: guidelines
status: ready
created: 2026-10-14
---

# Command-line tools that work well for agents

## Intent

Coding agents (Claude Code, Codex) check their work through command-line tools, not the editor. So the multifront
commands are the main way an agent sees whether a `.ucf` change is right. An agent works in small steps: it wants to
check the one file it just changed, or one framework of that file, fast, and read the result without guessing. Today
the plans only cover whole-project runs with plain text output. This work is done **before milestone 7**, so its
commands (`mf-tsc`, `mf-lint`, `mf-fmt`) are built agent-friendly from the start instead of reworked later.

## Direction

- **Investigate first.** For each command, what it can and will do: `mf-build` (exists: `--framework`, `--no-dts`,
  `--out-dir`, `packages/vite/bin/mf-build.js`) and `mf-tsc`, `mf-lint`, `mf-fmt` (planned in
  `docs/milestones/m7-full-editor-support.md`, steps 7.1 to 7.8). Compare with what agents already get from
  `tsc`, `vue-tsc`, `svelte-check` (it has `--output machine` and a JSON-ish format) and `oxlint` (`-f json`).
- **Pick what to check.** Every command takes one or more files or folders. `mf-tsc` also takes a framework filter
  (one target of one file). `tsc` cannot check one file with the project's tsconfig settings, so decide how `mf-tsc`
  does it (load the tsconfig, report only the given files, or check only them).
- **Output.** A readable default and a machine format (`--format json`), one shape shared by every command: file,
  line, column, end, code, severity, message, plus the block and the framework when it applies. Positions are always
  in the `.ucf` file, never in a generated file. A one-line summary. Quiet when all is fine.
- **Exit codes** the same everywhere: 0 clean, 1 findings, 2 bad usage or config.
- **Speed.** Measure a one-file check against a whole-project check on the fixtures; consider reusing work between
  runs (TypeScript's incremental build info) if one file is slow.
- **Help.** `--help` on every command lists its options with an example; an unknown option says which ones exist.
- The implementer plans the details (exact flag names, the JSON shape, how one-file `mf-tsc` works).

## Docs

- `docs/milestones/m7-full-editor-support.md`: the main output. Steps 7.1 to 7.8 (and the gate and exit test) gain the
  file and framework selection, the shared output, exit codes, help, and tests for them.
- `docs/spec.md`: section 5 "Where it runs" (`mf-tsc` options) and the lint / format part of section 6.
- `docs/plan.md`: the milestone 7 section, one line on the agent-friendly command rules.
- `publicdocs/`: none now; no page describes these commands yet. Milestone 7's docs writer covers them.

## Done when

- The milestone 7 plan says, for each command, how to check one file, a folder, and (for `mf-tsc`) one framework;
  what the readable and JSON output look like; the exit codes; and the help text. Each has a planned test that runs
  the real command on real fixtures.
- `mf-build` follows the same output and exit code rules, or the gap is fixed here with a test.
- The simplify-comments pass ran on every touched source file, committed on its own.
