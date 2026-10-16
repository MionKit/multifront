---
type: feature
spec: full-plan
status: ready
created: 2026-10-16
milestone: 7
step: 7.13
---

# Package the VS Code extension

## Problem

`pnpm devx vsix` already packs a bundled `.vsix`: the extension, the server and the TypeScript plugin (its pack under the extension's own `node_modules`), oxc's wasm binding, no TypeScript, oxlint or oxfmt. But:

- It has no Marketplace fields (`displayName`, `icon`, `categories`), so it is not ready to publish (7.14).
- Nothing proves the packed file works on its own: no test installs the `.vsix` into a real VS Code, nor runs it on lint, format and markup completion together.
- The VS Code harness downloads VS Code into `.vscode-test/` with no lock, so only `exit.spec.ts` may start VS Code (docs/milestones/README.md, "Editor: real VS Code"). A second spec starting it would race that download.

## Plan

1. **Marketplace fields** in `packages/vscode/package.json`: `"displayName": "multifront"`, `"icon": "assets/icon.png"`, `"categories": ["Programming Languages", "Formatters", "Linters"]`; `files` gains `assets/icon.png`. The Marketplace refuses an SVG icon, so the icon is a PNG: its source `docs/assets/src/vscode-icon.html` (a 128 px `.canvas` showing `packages/vscode/icons/ucf.svg`), rendered by `pnpm devx docs-images` to `packages/vscode/assets/icon.png` (256x256 at its scale 2). `scripts/docs-images.mjs` gets the one output path that leaves `docs/assets/`. HTML and PNG committed together.
2. **The VS Code download behind a lock** in `packages/e2e/editor/lib/vscode.ts`: `vscodeExecutable()` takes the lock folder `.vscode-test/download.lock` (`mkdir`, polled; a lock older than 15 min, left by a killed run, is removed), runs `@vscode/test-electron`'s `downloadAndUnzipVSCode({version: VSCODE_VERSION, cachePath})`, releases the lock in a `finally`, returns the executable; `runInVsCode` passes it as `vscodeExecutablePath`. So any spec may start VS Code; the README infra row, the `exit.spec.ts` comment saying otherwise and the CI cache comment change.
3. **The harness installs a `.vsix`.** `RunOptions` takes `extension` (a development folder, as now) or `vsix` (a packed file). With `vsix`, VS Code's own CLI (`resolveCliArgsFromVSCodeExecutablePath`) runs `--install-extension <vsix> --extensions-dir <temp>/extensions` first (a non-zero exit throws with its output), and VS Code starts with that extensions folder and an empty development folder, so the installed copy is the one that runs (VS Code runs a test suite only beside a development path). New `data` option: written to `<temp>/data.json`, its path given as `MULTIFRONT_VSCODE_DATA` (an `internal` row in `scripts/lib/env.mjs` `REGISTRY`); the suite reads its expected results there.
4. **`packVsix(dir)` keeps the packed file** (`packages/e2e/editor/lib/vsix.ts`): it also copies the `.vsix` to `join(dir, VSIX_FILE)` (new export) before deleting its temp repo. Its return (the unzipped `extension/` folder) and its callers stay as they are.
5. **Docs:** `docs/architecture.md` "Packaging" says TypeScript, oxlint and oxfmt are never bundled (the workspace's TypeScript, VS Code's as fallback, the workspace's oxlint and oxfmt) and the manifest carries the Marketplace fields. Milestone step 7.13 gets `- Status: done`, its text matched to what shipped.

## Decisions

- Icon: a committed PNG rendered from HTML by `pnpm devx docs-images`, the HTML under `docs/assets/src/` (AGENTS.md graphics rule), the PNG at `packages/vscode/assets/icon.png`, with the smallest change to `scripts/docs-images.mjs`.
- M2's `packages/e2e/editor/vsix.spec.ts` stays where it is; the new checks go in `packages/e2e/editor/vscode/vsix.spec.ts`, as the step names.
- VS Code in two spec files: a download lock in the harness. 7.14 runs the 7.13 `vsix.spec.ts` alone in the release workflow, so it must start VS Code itself.

## Tests

Area Editor. Runs on this host (Xvfb and the cached VS Code 1.137.0) and in CI's `check` job and floor jobs (`pnpm devx test` with the `.vscode-test` cache; the harness starts Xvfb).

`packages/e2e/editor/vscode/vsix.spec.ts`; `beforeAll`: `packVsix(temp)`, `temp` in `os.tmpdir()` (the real `pnpm devx vsix` in a temp repo copy, so it never races `editor/vsix.spec.ts` over `packages/vscode/dist`), giving the unzipped extension and the `.vsix`.

0. The packed `package.json` has the `displayName`, `categories` and `icon`; the packed icon is a square PNG of at least 128 px (signature and IHDR).
1. The server from the unzipped files, over stdio, with no repo `node_modules` beside it: `createRequire(<extension>/dist/server.cjs).resolve('@volar/language-server')` throws. One server on a copy of `lint-format/` (`formatting(LINT_FORMAT, {server})`): completion after `<input bi` in `Clean.ucf`'s `<svelte>` markup lists `bind:value`; the pulled oxlint diagnostics of `Lint.ucf` equal the real `mf-lint --format json` findings; Format Document on `Messy.ucf` gives exactly what the real `mf-fmt` writes on the second copy.
2. A real VS Code with the `.vsix` installed (`runInVsCode({vsix, workspace, suite, data})`), on a `copyApp('types-every-target')` copy with its own `.oxlintrc.json` (`no-debugger` an error) and `.oxfmtrc.json` (`{}`), since the repo's configs ignore `**/.tmp/**`. `Greeting.ucf` edited: `label={String(count)}` to `label={count}` (TS2322 in `<react>`), a `debugger` line in the `<vue>` script. `data`: the real `mf-tsc` and `mf-lint` `--format json` findings on that file, and the real `mf-fmt` output on a second copy with the same edits. The suite `packages/e2e/editor/vscode/vsix.cjs` checks: `Greeting.ucf` has language id `ucf` and the running extension is the installed one (its `extensionPath` under the fresh extensions folder); `vscode.languages.getDiagnostics` holds every `mf-lint` finding (`source: 'oxlint'`, code, range) and every `mf-tsc` finding (TypeScript's code, range); `vscode.executeFormatDocumentProvider`'s edits applied give the `mf-fmt` output byte for byte; a hover on `<Greeting` in `main.tsx` shows `name: string` and `count?: number` (the TypeScript plugin loaded from the installed pack).

`packages/e2e/editor/vsix.spec.ts` (M2): its exact list of packed files gains `assets/icon.png`.

## Fuzzing

None: packaging has no cheap oracle.

## Out of scope

- Publishing, the release workflow and the store accounts (7.14).
- The milestone 7 exit test.
- The extension README beyond what it says today.

## Done when

- `pnpm devx vsix` packs a `.vsix` with the Marketplace fields and the icon.
- The new spec passes here and in CI, the CI log showing its checks run.
- `pnpm devx check` is green.
- The simplify-comments pass ran on every touched source file, committed on its own.
