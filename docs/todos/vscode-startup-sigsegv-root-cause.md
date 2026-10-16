---
type: fix
spec: guidelines
status: ready
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
- 2026-10-16, it happened again with a dump: a full `pnpm devx check` on the cloud host, `exit.spec.ts`'s packed-extension
  run, SIGSEGV with the same D-Bus lines. The dump (Crashpad minidump, read with the `minidump` Python package):
  25 threads; the crashing one jumped to address `0x0`. A raw scan of its stack (not an unwound trace) finds code addresses in `libexpat.so.1`
  (`+0x22213`, `+0x74a4`, `+0xc665`) called from `libfontconfig.so.1` (`+0x37998`, `+0x2f6c9`): likely fontconfig parsing
  its XML config through expat, not D-Bus. A rerun of `exit.spec.ts` alone passed. The dump stayed on that host only.

## Direction

- The 2026-10-16 dump points at fontconfig reading its config at startup (above). Look there first: which fonts
  config the host has, whether VS Code's bundled or the system fontconfig/expat loads, and whether a harness-owned
  `FONTCONFIG_FILE` (a minimal config) or a warmed font cache (`fc-cache`) before the run stops the crash.
- A D-Bus thread was the earlier guess; the dump does not support it.
- The fix makes the harness stable; it never retries, skips or quarantines the test.

## Done when

- The cause is named from a dump and fixed in `packages/e2e/editor/lib/vscode.ts` or the host setup.
- `exit.spec.ts` passes in repeated full `pnpm devx check` runs on the cloud host and in CI.
