---
type: fix
spec: guidelines
status: ready
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
