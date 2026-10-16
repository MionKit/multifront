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

## Plan: harness-owned fontconfig sysroot (2026-10-16, delegated session, automatic mode)

No human could approve the plan in this delegated session; it was decided under automatic mode, safer option each time.

### Findings

- VS Code 1.137.0 bundles neither fontconfig nor expat: `ldd code` loads the host's `libfontconfig.so.1` (2.15.0)
  and `libexpat.so.1` (2.6.1). Same Claude web image, same Ubuntu builds: the dump's offsets map onto these files.
- The dump's `libfontconfig.so.1+0x2f6c9` is the return address of fontconfig's `call XML_ParserCreate`: the crashed
  thread was starting to parse a config file. The expat frames are `prologInitProcessor`'s tokenizer call (`+0xc665`)
  and expat's debug-level `getenv` reads (`+0x22213`, `+0x74a4`, `EXPAT_MALLOC_DEBUG`).
- In VS Code's main process, only one thread makes that call: pango's background `FcInit` thread (gdb backtrace:
  `XML_ParserCreate` ← libfontconfig ← `FcInit` ← libpangoft2 ← glib thread). Mesa's driconf also parses XML through
  expat, but on the main thread, never from libfontconfig.
- That thread parses 64 files (the host's `fonts.conf` with `conf.d`, plus the 46 `conf.avail` templates fontconfig
  2.15 always scans) in about 10 ms, starting about 10 ms after the D-Bus lines. The main thread meanwhile adds new
  environment variables (`VSCODE_NLS_CONFIG`, `VSCODE_CODE_CACHE_PATH`, `VSCODE_IPC_HOOK`, `VSCODE_PID`): 4 to 10 ms
  after the parse ends when idle, inside it under load. glibc 2.39's `getenv` is not safe against a concurrent
  `setenv` that grows the environment; no other shared-state write (locale, `dlclose`, a second `FcInit`) happens in
  that window (LD_PRELOAD trace of `setenv`, `setlocale`, `dlclose`, `Fc*` init calls).
- Not reproduced: 30 starts with a 3000-file config stretching that parse to 1.3 s over every `setenv` did not crash.
  The exact partner of the race stays unproven; the crashed thread and the work it was doing are proven.

### Built

- `runInVsCode` (`packages/e2e/editor/lib/vscode.ts`) gives VS Code `FONTCONFIG_SYSROOT`, on Linux only:
  `packages/e2e/.tmp/vscode-fontconfig/`, holding one `etc/fonts/fonts.conf` (`/usr/share/fonts` + a cache dir inside
  the root) and a link to the host's fonts. A sysroot, not `FONTCONFIG_FILE`: with `FONTCONFIG_FILE` fontconfig still
  scans the 46 templates. Pango's thread now parses 1 file in about 0.2 ms, done about 12 ms before the first
  `setenv`. The font cache inside the root warms on the first run.
- Test: `exit.spec.ts` runs `fontconfig.cjs` in VS Code (Linux). It reads the main process's real environment from
  `/proc`, runs the host's `fc-match` with that `FONTCONFIG_SYSROOT` and `FC_DEBUG=1024`, and checks one config file
  loaded, no template scan, a font found. It fails without the fix ("the main process has no FONTCONFIG_SYSROOT").
- `mainProcess()` moved from `crash.cjs` to `harness.cjs`, shared by both suites.
