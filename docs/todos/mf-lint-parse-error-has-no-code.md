---
type: fix
spec: guidelines
status: ready
created: 2026-10-16
---

# mf-lint prints `undefined` as the code of an oxlint parse error

## Intent

oxlint reports a block that does not parse (`const = ;` in `<react>`, `<vue>` or `<svelte>`) as a diagnostic with no
`code`, no `url` and no `help`. `lintUcf()` passes it on as is, though `UcfLintDiagnostic.code` is typed `string`, so:

- `mf-lint` prints `Broken.ucf:3:9: error undefined (react): Unexpected token`;
- `mf-lint --format json` gives a finding with no `code`, which spec 8.1's `Finding` requires.

An agent that reads the code (spec 8.1: "a coding agent runs it ... and acts on the result") gets nothing to act on.
Found while building the server's lint diagnostics, which show the same finding with no code (as oxlint's own language
server does) and test it.

## Direction

- Give the finding a code in `lintUcf()` (`packages/language-tools/src/lint/index.ts`), or make `code` optional in
  `UcfLintDiagnostic` and give `mf-lint`'s `Finding` one. A new core `DiagnosticCode` (spec 8.1, "one code per error")
  in the shape of `format-error` is the likely answer: `lint-parse-error`, say. The implementer decides and plans.
- `mf-lint`'s text and JSON output pinned for a block that does not parse, in `packages/e2e/editor/lint/mf-lint.spec.ts`.
- If the server should show the new code too, its lint spec's parse-error case changes with it.

## Docs

spec 8.1 if a code is added (the list of codes lives in core's `DiagnosticCode`); `docs/milestones/m7-full-editor-support.md`
"New codes" line.

## Done when

- `mf-lint` on a `.ucf` file whose block does not parse prints a real code in both output formats, pinned by a test.
- The simplify-comments pass ran on every touched source file, committed on its own.
