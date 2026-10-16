---
type: fix
spec: guidelines
status: done
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

## Plan: wait out the crash reporter, never let cleanup replace the error (approved 2026-10-16, automatic mode)

Findings, from a real crash logged at the moment `runTests` rejected:

- Only `chrome_crashpad_handler` is still alive then: parent 1, its own process group, `--database=<temp>/crashes`.
  It still moves the dump from `new/` to `pending/` and writes `.meta` and `settings.dat`. It is gone within 100 ms
  here; on a slower CI runner the `rm` lands in that window. `keepCrashDumps` races it the same way.

Plan:

- `runInVsCode` waits until no process has its temp folder in its command line (`ps -A -ww`, 10 s cap, then
  SIGKILL), before it copies the dumps and before it deletes the folder. `rm` gets `maxRetries`.
- A failed run: a cleanup error becomes a note in VS Code's error, never thrown in its place.
- Test: `crash.cjs` leaves a detached writer in the run's folder for about 3 s, as Crashpad does for a moment;
  `exit.spec.ts` checks the error is still VS Code's and the folder is gone.

## What shipped

As planned, plus two tests the review asked for. Without the fix the first test fails with CI's exact error:
`ENOTEMPTY, Directory not empty: '/tmp/multifront-vscode-OcqQaA'`.

- Each cleanup step of a failed run goes through one helper that turns its error into a note.
- Three crash suites share `crash.cjs`: a writer that stops after about 3 s (the harness waits for it), one that
  never stops (the harness kills it at 10 s), and a file blocking the dump folder (its error is a note, the folder
  is still deleted). Each new test fails when its branch is removed.
- No test makes `rm` itself fail: no writer outpaces Node's `rm` here, and as root no permission blocks it.
  That step uses the same tested helper.
- On Windows the wait is skipped (no `ps`); `rm`'s retries remain.
- `docs/milestones/README.md` "Editor: real VS Code" names the wait.
