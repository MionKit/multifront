---
type: fix
spec: guidelines
status: done
created: 2026-10-11
---

# Editor bundle test: tsserver start hook times out under a full run

## Intent

`pnpm devx check` failed once on a docs-only branch: `packages/e2e/editor/bundle.spec.ts`, describe "tsserver with the
plugin pack alone, as VS Code with its own TypeScript loads it", `beforeAll` at line 67, "Hook timed out in 10000ms".
The run right after passed 48 of 48 files. So the gate can go red with no change to the code: a flaky test.

The e2e project sets `testTimeout: 60_000` (`packages/e2e/vitest.config.ts:10`) but no `hookTimeout`, so hooks keep
Vitest's 10 s default. This hook starts an isolated tsserver that loads the bundled plugin pack (a 2 MB CJS file) and
waits for `updateOpen` on three files. Under the full suite's load, that can take longer than 10 s.

## Direction

- Find which hooks start a real process (tsserver, the language server, `pnpm devx vsix`, VS Code). Give them the room
  their tests already get: an e2e `hookTimeout`, or a timeout argument on each such hook, matching the tests' budget.
- First check how long that hook really takes in a loaded full run, so the new limit has a real reason and does not
  hide a slowdown.
- The implementer plans the details.

## Docs

None: no documented behaviour changes.

## Done when

- The hooks that start real processes have a timeout that matches the work they do, with the reason in one line.
- `pnpm devx check` passes. The simplify-comments pass ran on every touched source file, committed on its own.

## Plan: e2e hookTimeout (approved 2026-10-11, automatic mode)

- Measured under three full `pnpm devx test` runs (4 cores, 48 files, all green): the "pack alone" `beforeAll` took
  7.6, 7.8 and 8.6 s; the "pack + own plugin" one 5.3 to 6.1 s; the language server start under 0.5 s.
  Close enough to the 10 s default that a busier machine fails it.
- The hooks that start a real tool (tsserver, the language server, Vite, a browser) are spread across the project,
  so the fix is project-wide:
  `hookTimeout: 60_000` in `packages/e2e/vitest.config.ts`, the same budget as `testTimeout`, with a one-line reason.
- Hooks that already pass a longer limit (`pnpm devx vsix` pack at 120 s, VS Code at 900 s) keep it.
- No new test: the change is to the test runner's limit; the gate's full run is its check.
