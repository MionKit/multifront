---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.11
---

# Real VS Code test harness and the M2 exit test (M2 step 2.11)

## Problem

Steps 2.2 to 2.10 test each piece over its own protocol (textmate, LSP, tsserver). Nothing yet opens a `.ucf` file in a real VS Code with the packed extension. Step 2.11 builds that harness, runs the milestone exit test (6 checks) in it, and checks 2.10's `activate` / `deactivate`. CI has no VS Code, no display and no cache today.

Facts from a throwaway probe (VS Code 1.141.0 tarball, the `.vsix` from `main` unzipped, `xvfb-run`, a probe `extensionTestsPath`):

1. Works as root with `--no-sandbox` (test-electron adds it). The download is about 360 MB.
2. `Card.ucf` opens as `ucf`. `_workbench.captureSyntaxTokens` gives `keyword.control.export.tsx` under `meta.embedded.block.react`, Vue `punctuation.definition.interpolation.begin.html.vue`, Svelte `meta.script.svelte … storage.type.ts`.
3. Completion after `$style.` lists `card`. Definition on `$style.card` lands on `.card`. The App.tsx hover first says `(loading...)`, then shows `title: string`: every check polls.
4. Diagnostics come only for documents shown in an editor (`openTextDocument` alone gives none in 60 s), so the suite calls `showTextDocument`.
5. The server runs as a child of the extension host: `<ext>/dist/server.cjs --node-ipc --clientProcessId=<pid>`. `require('<ext>/dist/extension.cjs')` inside the suite returns the module the host loaded; its `deactivate()` stops the client and the process is gone 2 s later.
6. `ext.isActive` is still false right after the open: poll it.
7. test-electron 3.1.0 (2026-07-24) downloads through `npm_config_https_proxy` and passes `process.env` plus `extensionTestsEnv` to VS Code. Without its own args it reuses `<cachePath>/user-data`, so a hot-exit backup of an unsaved edit could come back in the next run: each run gets fresh temp folders.

## Plan

### Decisions (approved by the orchestrator)

- **VS Code pin: 1.137.0**, the newest stable at least 30 days old (released 2026-09-08). A VS Code build the tests download and run gets the same 30-day floor as npm packages (`minimumReleaseAge` in `pnpm-workspace.yaml`).
- **Display: the harness starts its own `Xvfb -displayfd` on Linux with no `DISPLAY`**, so `pnpm devx test` and `check` run on headless hosts and in CI with no wrapper. Missing Xvfb fails with "install xvfb".
- **Development extension = the unzipped `.vsix`** from `pnpm devx vsix` run in a temp repo copy, as `bundle.spec.ts` does: it tests what ships and never races `vsix.spec.ts` over `packages/vscode/dist`.

- **Found while building, fixed here (own commits):** the unzip lowercased every entry name (vsce's `readZip`), so VS Code found no `*.tmLanguage.json` grammar; it now unzips with vsce's `yauzl`, names as packed. VS Code's TypeScript extension activates on JS and TS files only, so a lone `.ucf` file got no tsserver features: `activate` now activates `vscode.typescript-language-features` first (the exit test opens `Card.ucf` first, and 4 checks fail without it).

### Changes

1. Root `package.json`: devDependency `@vscode/test-electron` `3.1.0` (exact), plus `pnpm-lock.yaml`. `.gitignore`: `.vscode-test/`.
2. `packages/e2e/editor/lib/vsix.ts`: new `packVsix(dir): Promise<string>`: `tempRepo()`, the real `devx.mjs vsix`, `unzipVsix` into `dir`, temp repo removed, returns `<dir>/extension`. `bundle.spec.ts`'s `beforeAll` calls it instead of its inline copy.
3. `packages/e2e/editor/lib/vscode.ts` (new): `VSCODE_VERSION = '1.137.0'`, `CheckResult {name, error?}`, `runInVsCode({extension, workspace, suite}): Promise<CheckResult[]>`: temp `user-data`, `extensions` and `results.json`; a display; `runTests({version, cachePath: <repo>/.vscode-test, extensionDevelopmentPath: extension, extensionTestsPath: suite, launchArgs: [workspace, --user-data-dir, --extensions-dir], extensionTestsEnv: {MULTIFRONT_VSCODE_RESULTS, DISPLAY}, stdout/stderr captured})`. A failed run throws with the captured output tail. Returns the parsed results; cleans up and stops Xvfb.
4. `packages/e2e/editor/vscode/harness.cjs` (new, runs inside VS Code): `runChecks(checks)` runs each `{name, run}` in order, records `{name}` or `{name, error}`, writes JSON to `MULTIFRONT_VSCODE_RESULTS`, never throws. Helpers: `until(probe, what)`, `show(path)` (a non-preview tab: VS Code checks only documents open in a tab, and a preview tab is replaced by the next), `positionOf`, `hoverText`, `codeOf`, `serverProcesses(extensionPath)` (`ps -A -o pid=,ppid=,args=`: children of the extension host running `<ext>/dist/server.cjs`). Later milestones write their own suite with it.
5. `packages/e2e/editor/vscode/suite.cjs` (new): `exports.checks` (`vscode` required inside each `run`, so the spec reads the names outside VS Code) and `exports.run`. Workspace `fixtures/apps/imports/`, components read from `../../components`, extension found by `packageJSON.name === 'multifront-vscode'` (no publisher until M7). Checks, in order:
   - activate: showing `Card.ucf` activates the extension, which forks `dist/server.cjs` over IPC.
   - exit 1: `Card.ucf` has language id `ucf`; `captureSyntaxTokens`: `export` in `<react>` is `keyword.control.export.tsx`, `padding` in `<style module lang="scss">` is `support.type.property-name.css` in `meta.embedded.block.style.scss` and the SCSS grammar's `meta.property-list.scss`, `{{` in `<vue>` is `punctuation.definition.interpolation.begin.html.vue`, `let` in `<svelte>` is in `meta.script.svelte` and `storage.type.ts`, each inside its block's content scope.
   - exit 2: completion after `$style.` in `<react>` lists `card`; definition on `$style.card` lands on `card` in `.card`; hover on `<Card` in `editor/Profile.ucf` shows `title: string`.
   - exit 3 (also: the server answers over IPC): hover on `padding` in `Panel.ucf`'s `<style>` has its CSS docs (`the padding area`).
   - exit 4: `editor/TypeError.ucf` has `2322` on the `label:` line; `invalid/DuplicateReact.ucf` has `duplicate-target` from `multifront`.
   - exit 5: hover on `<Card` in `src/App.tsx` shows `title: string`; definition on `Card` lands in `Card.ucf` inside `<react>`.
   - exit 6: `applyEdit` turns `Card({ title }: { title: string })` into `Card({ heading }: { heading: string })` with no save; `App.tsx` gets `2322` on its `<Card` line while `Card.ucf` is dirty and unchanged on disk; then revert, and `App.tsx` is clean again.
   - deactivate: `deactivate()` of the module the host loaded stops the server process.
6. `packages/e2e/editor/vscode/exit.spec.ts` (new): `beforeAll` (15 min, covers the first download) runs `packVsix(temp)` then `runInVsCode(...)`; one test per name in `suite.cjs` `checks`: the result exists (a missing one means the suite died there) and has no `error`.
7. `.github/workflows/ci.yml`, `check` job: `actions/cache@v5` on `.vscode-test`, keyed on the runner OS and `packages/e2e/editor/lib/vscode.ts`, before Test, and the Test step runs with `--reporter verbose` so the log names every test that ran. The harness starts Xvfb, which `ubuntu-latest` ships. The `windows` job does not run this file.
8. `scripts/lib/env.mjs` REGISTRY (`internal`): `DISPLAY`, `MULTIFRONT_VSCODE_RESULTS`.
9. `SETUP.md`: the VS Code test downloads VS Code into `.vscode-test/` on first run (about 360 MB); on Linux with no display it starts Xvfb.

## Tests

- `packages/e2e/editor/vscode/exit.spec.ts`: every check, on this host (Xvfb present, download through the proxy) and in CI's `check` job (`pnpm devx test`, ubuntu-latest, cached `.vscode-test/`). Each check fails without its feature: no grammar means wrong scopes, no pack means no `$style` completion or App hover, no server means no Panel hover or `duplicate-target`, no `deactivate` means the process stays.
- `bundle.spec.ts`, refactored to `packVsix`, stays green.
- The CI log lines with the exit.spec checks passing are quoted to the orchestrator.

## Docs

- `docs/milestones/m2-editor-basics.md` 2.11: text as shipped (unzipped `.vsix`, `runInVsCode`, `harness.cjs`, own Xvfb, VS Code 1.137.0 and the 30-day floor, `@vscode/test-electron` 3.1.0), `- Status: done`; "Hands to later milestones": editor helpers row and root devDependencies row.
- `docs/milestones/README.md` "Test infrastructure", row "Editor: real VS Code".
- `docs/milestones/m7-full-editor-support.md` 7.13: "under `xvfb-run` on Linux" becomes 2.11's `runInVsCode`.
- `SETUP.md` as above. No spec, plan, architecture or publicdocs change: test infra only.

## Fuzzing

None: a harness has no cheap oracle.

## Out of scope

- Installing the `.vsix` with `--install-extension` (M7 7.13). VS Code tests on Windows or macOS CI. Editor checks beyond the exit test and `activate` / `deactivate`. Marketplace fields.

## Done when

- `exit.spec.ts` passes every check here and in CI, and the CI log shows them run.
- `bundle.spec.ts` still passes; `pnpm devx check` green.
- Docs above updated; step 2.11 marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
