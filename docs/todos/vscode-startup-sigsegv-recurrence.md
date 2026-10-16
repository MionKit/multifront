---
type: fix
spec: guidelines
status: ready
created: 2026-10-16
---

# Confirm VS Code's startup crash on the cloud host is gone, or find the other side of the race

## Intent

VS Code 1.137.0's main process crashed with SIGSEGV twice in `pnpm devx check` on a Claude Code web host, in
`packages/e2e/editor/vscode/exit.spec.ts`, never in CI (GitHub issue #166). A gate that turns red without a code
change hides real failures and costs a rerun.

What is true today:

- The crashed thread was pango's background `FcInit` thread in the main process, while fontconfig started parsing
  an XML config file through the host's expat (Crashpad dump, mapped onto the host's `libfontconfig.so.1` 2.15.0).
- `runInVsCode` (`packages/e2e/editor/lib/vscode.ts`, `fontconfigRoot`) now gives VS Code a `FONTCONFIG_SYSROOT`
  with one config file and a warmed cache: that thread parses 1 file in about 0.2 ms instead of 64 in about 10 ms,
  done well before the main thread's first `setenv` of a new `VSCODE_*` variable.
- That shortens a window; it does not prove what the thread raced with. The only shared-state write seen in that
  window is the main thread's `setenv` (glibc 2.39 `getenv` is not safe against it). A 3000-file config that
  stretched the parse to 1.3 s over every `setenv` did not crash in 30 starts.

## Direction

- Count: run full `pnpm devx check` repeatedly on the cloud host (at least 20 gates) and watch CI for a few weeks.
  Record the runs here. No crash → close issue #166.
- A crash comes back → the harness keeps its dump under `packages/e2e/.tmp/vscode-crashes/`. Unwind every thread
  (not a raw stack scan), to see what the main thread was doing at that moment.
- Never retry, skip or quarantine the test.

## Done when

- At least 20 full gates on the cloud host and the CI runs since pass `exit.spec.ts` with no SIGSEGV, or a new dump
  names the other thread and a fix removes that race.
