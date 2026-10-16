---
type: fix
spec: guidelines
status: ready
created: 2026-10-16
---

# A crashed VS Code run's cleanup error hides VS Code's own error

## Intent

CI job `react-floor` (run 38938823291, on a docs-only commit) failed `editor/vscode/exit.spec.ts`,
"a VS Code that dies by SIGSEGV". The same code passed one commit earlier:

```
AssertionError: expected 'ENOTEMPTY, Directory not empty: \'/tm…' to contain 'Test run terminated with signal SIGSE…'
Received: "ENOTEMPTY, Directory not empty: '/tmp/multifront-vscode-Iqsu9K'"
```

`runInVsCode` (`packages/e2e/editor/lib/vscode.ts`) deletes its temp folder in `finally` while what is left of the
crashed VS Code (Crashpad, child processes) still writes into it. The `rm` error then replaces VS Code's own error,
crash dump note included. A gate red without a code change hides real failures and costs a rerun.

## Direction

- Root-cause it: wait until no process of that VS Code run still uses the temp folder before deleting it,
  and/or `rm` with `maxRetries`. No blind retry of the test.
- A cleanup failure never hides VS Code's error: it is added to that error, never thrown in its place.
- A test that fails without the fix, through a real VS Code. The implementer plans the details.

## Docs

None expected. If the harness gains a rule, the "Editor: real VS Code" row of `docs/milestones/README.md`
"Test infrastructure" says so.

## Done when

- The SIGSEGV case passes again and again; a crash's leftover writers never turn its error into `ENOTEMPTY`.
- A test proves it and fails without the fix.
- The simplify-comments pass ran on every touched source file, committed on its own.
