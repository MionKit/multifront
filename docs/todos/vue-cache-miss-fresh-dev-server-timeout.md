---
type: fix
spec: guidelines
status: ready
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
