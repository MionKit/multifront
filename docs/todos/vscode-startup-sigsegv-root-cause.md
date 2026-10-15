---
type: fix
spec: guidelines
status: blocked
created: 2026-10-15
---

# Find why VS Code's main process sometimes crashes at startup on the cloud host

## Intent

Once, in a full `pnpm devx check` on a Claude Code web host, the pinned VS Code (1.137.0) died with SIGSEGV
within 0.3 s of starting, before any extension ran: `editor/vscode/exit.spec.ts` failed its
`--disable-extension` run. A gate that turns red without a code change hides real failures and costs a rerun.

What is known:

- Never seen in CI. Not reproduced on the cloud host: 0 crashes in 40 parallel full-suite runs under CPU load,
  300 bare starts (8 at once, during full gates) and several full gates.
- The crashed process is the main one: Crashpad's `cpufreq` and `Crashpad/attachments` lines in the output
  only appear when it writes a dump. They came about 60 ms after the D-Bus "Failed to connect to the bus" lines.
- `runInVsCode` now keeps that dump: the error names a folder under `packages/e2e/.tmp/vscode-crashes/`.
- `runInVsCode` no longer passes the host's `NODE_OPTIONS` to VS Code. Whether that was the cause is unknown.

## Direction

- Blocked until the crash happens again and leaves a dump.
- Read the dump: the crashing thread, its module and offset (e.g. the `minidump` Python package lists threads).
  A D-Bus thread would point at the missing system bus on the host: then try a private `dbus-daemon` in the
  harness, as it already starts Xvfb.
- The fix makes the harness stable; it never retries, skips or quarantines the test.

## Done when

- The cause is named from a dump and fixed in `packages/e2e/editor/lib/vscode.ts` or the host setup.
- `exit.spec.ts` passes in repeated full `pnpm devx check` runs on the cloud host and in CI.
