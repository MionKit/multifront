---
type: fix
spec: guidelines
status: ready
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
