---
type: fix
spec: guidelines
status: done
created: 2026-10-15
---

# Real VS Code test run crashes with SIGSEGV now and then

## Intent

`packages/e2e/editor/vscode/exit.spec.ts` failed once in a full `pnpm devx check` on a Claude Code web host:
the pinned VS Code (1.137.0, `.vscode-test/` cache, Xvfb started by `editor/lib/vscode.ts`) died before its suite
reported. The case was "with VS Code's TypeScript extension disabled, the extension still starts its server" (the
`--disable-extension` run). Its other checks were then skipped (5 skipped). A rerun of the file alone passed (19 of
19). That's 1 crash in 3 runs of the file on that host (2 full gates, 1 run alone). The branch only changed `mf-tsc`,
nothing VS Code loads. A gate that turns red without a code change hides real failures and costs a full rerun
(about 9 minutes).

Crash output, as `runInVsCode` printed it:

```
Error: VS Code run failed: Error: Test run terminated with signal SIGSEGV
ERROR:electron/shell/common/node_bindings.cc:487] Most NODE_OPTIONs are not supported in packaged apps. See documentation for more details.
ERROR:dbus/bus.cc:406] Failed to connect to the bus: Failed to connect to socket /run/dbus/system_bus_socket: No such file or directory
ERROR:dbus/bus.cc:406] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq: No such file or directory (2)
ERROR:third_party/crashpad/crashpad/util/file/directory_reader_posix.cc:43] opendir /tmp/multifront-vscode-S4xYCt/user-data/Crashpad/attachments/...: No such file or directory (2)
Caused by: Error: Test run terminated with signal SIGSEGV
  ❯ ChildProcess.onProcessClosed @vscode/test-electron@3.1.0/out/runTest.js:125:24
```

## Direction

- First find out whether it also happens in CI's `check` job, or only on the cloud host (no dbus, no GPU, Xvfb).
- Likely suspects to check, not settled:
  - Electron's GPU process under Xvfb (`--disable-gpu`);
  - the shared `NODE_OPTIONS` (Electron warns about it);
  - two VS Code instances started close together by parallel e2e workers.
- The implementer investigates and plans. The fix makes the harness stable; it must not retry the test or skip it.

## Docs

None expected. If the harness gains a launch flag or an environment rule, the "Editor: real VS Code" row of
`docs/milestones/README.md` "Test infrastructure" says so.

## Done when

- The cause is found and fixed in `packages/e2e/editor/lib/vscode.ts` (or the CI setup), with evidence.
- `exit.spec.ts` passes in repeated full `pnpm devx check` runs on the cloud host and in CI.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Plan: keep the crash evidence, drop the host-only input (approved 2026-10-15, automatic mode)

Findings:

- CI: no crash in any `ci.yml` run (12 failed runs checked, none from VS Code). Cloud host only.
- The crash is VS Code's main process at startup, before any extension output. Its log is all one pid
  within 0.26 s. The `cpufreq` and `Crashpad/attachments` lines are Crashpad writing a dump: a normal start
  never prints them; a main process killed with SIGSEGV prints the same three. The dump lands in
  `user-data/Crashpad/completed`, which `runInVsCode` then deletes with its temp folder.
- No repro on the cloud host: 0 crashes in 40 parallel full-suite runs under CPU load, 300 bare starts
  (8 at once, during full gates) and 1 full `pnpm devx check` run.
- Host vs CI in the crash window: the host's `NODE_OPTIONS` (`--max-old-space-size=8192`) reaches Electron,
  which logs it as unsupported; no D-Bus system bus. `--disable-gpu` is out: a GPU process crash does not end
  the main process.

Plan:

- `runInVsCode`: a run fails → copy its Crashpad dumps to `packages/e2e/.tmp/vscode-crashes/`
  and name that folder in the error.
- `runInVsCode`: drop `NODE_OPTIONS` from VS Code's environment, as CI runs it.
- Test: `editor/vscode/crash.spec.ts` crashes a real VS Code with SIGSEGV and checks the dump is kept.
- The root cause stays open without a repro: a new todo reads the next kept dump.

## What shipped

Part of the Done-when, on purpose: the cause is not found, since the crash does not reproduce.

- `runInVsCode` starts VS Code with `--crash-reporter-directory` in its temp folder. Without it, VS Code 1.137.0
  starts Crashpad only if `~/.vscode/argv.json` enables it, which a fresh home (CI) does not. It also turns off
  the upload that moves a dump between folders.
- `runInVsCode` keeps any Crashpad dumps of a failed run in `packages/e2e/.tmp/vscode-crashes/` and names the
  folder in its error. A failed copy is named instead and never hides VS Code's own error.
- `runInVsCode` gives VS Code no `NODE_OPTIONS`.
- CI sets `kernel.core_pattern=/dev/null` in each job that runs `exit.spec.ts`. On GitHub's Ubuntu runners a
  crashed VS Code main process stayed in state D for minutes: the kernel piped its core (V8's huge reserved address
  space) to systemd-coredump. Any real crash there would have hung the job until its test timed out.
- `exit.spec.ts` gets a third run, `crash.cjs`: it sets `NODE_OPTIONS`, kills the real VS Code main process with
  SIGSEGV and checks the dump, the error line and the missing Electron warning. It sits in `exit.spec.ts`, not a
  file of its own: two files starting VS Code at once would race over the unlocked `.vscode-test/` download.
- 3 full `pnpm devx check` runs in a row on the cloud host with the fix (before the CI step): `exit.spec.ts` green in each, 4055 of 4055 tests.
- Reading the next dump and fixing the cause is a new todo, with the CI half of the repeated-runs item.
