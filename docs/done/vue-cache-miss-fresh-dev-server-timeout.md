---
type: fix
spec: guidelines
status: done
created: 2026-10-11
---

# vue-cache-miss: the fresh dev server case timed out once in a full run

## Intent

`packages/e2e/build/vue-cache-miss.spec.ts`, test "a .ucf sub-request plugin-vue has no descriptor for > is the first
request to a fresh dev server and returns the scoped CSS", failed once in a full `pnpm devx check` run on a cloud host
(2026-10-11, 61 test files in parallel). The run took 60624 ms. The reported error:

```
Error: Hook timed out in 60000ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".
 ❯ cli build/vue-cache-miss.spec.ts:38:3
     onTestFinished(() => vite.stop());
 ❯ build/vue-cache-miss.spec.ts:45:18
```

The hook that timed out is the `onTestFinished(() => vite.stop())` cleanup registered in `cli()`, which stops the
`vite` CLI process that `startViteCli()` (`packages/e2e/build/lib/freshProcess.ts`) spawned. The test passed when run
alone (7/7) and in the next full run (2235/2235). A test that fails under load hides real failures and turns CI red at
random, so find the root cause rather than raising a timeout.

## Direction

The implementer investigates and plans. Pointers:

- Find out why the test body ran to ~60 s: `vite.waitForOutput(/Local:\s+http\S+/)` or the `fetch` may have no bound
  of their own, unlike `runFreshDevServer()`, which kills its child at 50 s, before Vitest's 60 s timeout.
- Find out why `vite.stop()` then never settled within the hook timeout. `stop()` in `startNode()` sends one
  SIGTERM and awaits the child's `close` event with no bound and no SIGKILL fallback. A child that is busy or still
  holds its stdio may never emit it.
- Reproduce under load, e.g. the whole e2e project in parallel, several runs.
- The fix gives the waits a bound below the test timeout, with a message that says what was waited for, and makes
  `stop()` always settle. It must not loosen the test or skip it.

## Docs

None, because this is test infra only.

## Done when

- The root cause is named in the moved spec. The case fails fast with a clear message when the CLI never prints its
  URL, and its cleanup always settles.
- Repeated full `pnpm devx test` runs pass here and in CI.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Plan: bound the fresh-process waits (approved 2026-10-11)

Automatic mode, delegated session: the plan was decided without a user.

- `waitForOutput(pattern, count, timeoutMs = 30 s)` in `freshProcess.ts` rejects with the pattern, the count and the
  output so far, so a CLI that never prints its URL fails in 30 s with a clear message.
- `stop()` sends SIGTERM, then SIGKILL after a 5 s grace, and awaits the child's `exit`, not `close`: `close` also
  waits for stdio pipes a grandchild can hold.
- New cases: a real Vite CLI waits for output it never prints, and a real Vite
  CLI whose `server.close()` never settles (a `closeBundle` hook that never resolves and keeps a timer alive) is
  stopped. Both cases time out at 60 s without the fix.

## What shipped

**Root cause.** The test body passed in about 0.6 s; the 60 s went to the `vite.stop()` cleanup hook. `stop()` sent
one SIGTERM and awaited `close` with no bound. Vite's SIGTERM handler awaits `server.close()` before it exits, and that
waits with no bound for the dependency scan, the dependency bundling it started after the first request, in-flight
requests and the plugins' `buildEnd` / `closeBundle` hooks. Measured on the cloud host: 0.4 s alone, up to 3 s with
10 copies of the case and 8 busy loops in parallel. The 60 s stall itself did not reproduce in 2 full e2e runs, 2
full e2e runs under CPU load and 40 direct SIGTERM trials at varied delays, so which wait stalled stays unknown. The
fix does not depend on it: `stop()` now force-kills after 5 s.

- Changed from the plan after review: `stop()` still awaits `close`: Vite spawns no grandchild that could hold the pipes,
  and awaiting `exit` had no test that would fail without it. The two cases live in `vue-cache-miss.spec.ts`, which
  already has the app copy and the `cli()` helper.
- Also fixed: Vitest runs `beforeEach`'s cleanup before `onTestFinished`, so the case removed the app copy while its
  Vite CLI still ran. The cleanup now stops every CLI the case started, then removes the copy. 24 trials that removed
  the copy under a running CLI did not hang it either, so this is not shown to be the stall's trigger.
- Partial on one point, on purpose: which wait inside Vite's `server.close()` stalled for 60 s stays unknown, because
  the stall never reproduced. No follow-up spec: with a bounded `stop()` such a stall can no longer fail a test, and
  without a reproduction there is nothing to plan from.
- The `fetch` in the case got no bound of its own: Vitest's 60 s test timeout already fails it with
  the test's name, and with `stop()` settling, that failure is now reported instead of a hook timeout.
- Found on the way, unrelated: the tsserver "project outside the repo" cases inherit pnpm's `NODE_PATH` when Vitest
  starts through pnpm's bin shim, and one of them fails. Filed as a guidelines todo in this PR.
