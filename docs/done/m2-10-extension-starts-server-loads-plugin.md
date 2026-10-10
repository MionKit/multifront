---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.10
---

# The extension starts the server and loads the plugin (M2 step 2.10)

## Problem

`packages/vscode` ships only grammars. Step 2.10 makes one `.vsix` that also starts our language server and loads our TypeScript plugin into VS Code's tsserver, with nothing else to install. Facts found while planning:

1. **oxc-parser native binding.** The server and the plugin load core, and core's `blocks/react.ts` imports `parseSync` from `oxc-parser` at module load, which loads a per-platform `.node` file. Bundled with Rolldown, aliasing `oxc-parser` to its `src-js/wasm.js` entry and shipping `parser.wasm32-wasi.wasm` beside the bundle works: the bundled server answers hover and reports `react-no-default-export` like the native one (RSS 65 MB, no worker thread, `parseSync` only). Catch: `@oxc-parser/binding-wasm32-wasi@0.149.0` pins `@emnapi/core` / `@emnapi/runtime` `2.0.0-alpha.3` while `@napi-rs/wasm-runtime` declares the peer `^1.7.1 || ^2.0.0-alpha.4`. With emnapi 1.x it crashes (`this.bridge.setLastError is not a function`), with alpha.3 it works, so pnpm needs a `peerDependencyRules.allowedVersions` entry.
2. **vsce never packs `node_modules` under `--no-dependencies`.** `collectAllFiles` globs with `ignore: 'node_modules/**'` (`@vscode/vsce/out/package.js:1253`). A `node_modules/<pack>` folder ships only when `npm list --production --parseable` lists it as a dependency, which fails in `packages/vscode` (`workspace:*` deps are "invalid" to npm) but works in a clean folder whose only dependency is the pack.
3. **tsserver loads plugins by package name only** (`typescript.js:193880` refuses relative or `..` names), from `<probe>/node_modules/<name>`, probe locations first, then `<tsserver>/../../..` (`typescript.js:189285`). Project plugins load before global ones.
4. **Two copies of our plugin break each other.** VS Code with the workspace TypeScript finds the project's own `@multifront/language-tools/typescript-plugin` (listed in `tsconfig.json` for its options) and also loads the global pack under another name, so tsserver does not dedupe. Tried with the bundled pack plus the source entry: `App.tsx` quickinfo loses Card's props, `mixed.ts` gets `mixed-frameworks` twice plus a leaked TS1192. Volar's own guard is per module copy.

## Plan

### Decisions (approved by the orchestrator)

- **oxc through its wasm binding: one universal `.vsix`.** One `.vsix` per platform would need every platform's native binding on the packing machine, and breaks "one `.vsix`".
- **The pack is a redirect.** The plugin bundle sits in `dist/` next to the server and the one wasm file (`parser.wasi.cjs` reads the wasm from its own `__dirname`). `node_modules/multifront-typescript-plugin-pack/index.js` is `module.exports = require('../../dist/typescript-plugin.cjs')`, the way Vue's extension writes its plugin redirects.
- **vsce runs on a staged copy** in `os.tmpdir()`: the manifest's `files` plus a manifest whose only `dependencies` entry is the pack, so vsce's npm listing packs the pack folder. Public vsce CLI only.
- **Cross-copy guard in the plugin** (finding 4, fixed here, own commit and test): the first copy in a project wins, later copies step aside and log it.

### Changes

1. `packages/language-tools/src/typescriptPlugin.ts`: wrap the `createLanguageServicePlugin(...)` result; its `create(info)` checks `Symbol.for('multifront.typescript-plugin')` on `info.project`. Set → log `multifront: another copy of the TypeScript plugin already serves this project; this one steps aside`, return `info.languageService`. Else set it and call Volar's `create`. The default export stays a factory, so `typescript-plugin/index.js` is unchanged. `getExternalFiles` passes through (Volar returns `[]` for a project it did not decorate).
2. `packages/vscode/src/extension.ts`: `activate(context)` gets the tsdk with `getTsdk(context)` from `@volar/vscode` (VS Code's built-in TypeScript, or the workspace one when the user picked it) and starts a `LanguageClient` (`vscode-languageclient/node`) on `dist/server.cjs` over IPC (debug variant with `--inspect=6009`), `documentSelector: [{language: 'ucf'}]`, `initializationOptions: {typescript: {tsdk}}`. `deactivate()` stops it.
3. `packages/vscode/src/server.ts`: `startServer()` from `@multifront/language-tools/server`. `src/typescriptPlugin.ts`: re-exports the default of `@multifront/language-tools/typescript-plugin`.
4. `packages/vscode/package.json`: `main: ./dist/extension.cjs`, `activationEvents: ["onLanguage:ucf"]`, `contributes.typescriptServerPlugins: [{name: "multifront-typescript-plugin-pack", enableForWorkspaceTypeScriptVersions: true, languages: ["ucf"]}]`; `files` gets `dist` (replacing `dist/syntaxes`) and `node_modules/multifront-typescript-plugin-pack`; `dependencies` (bundled, exact pins): `@multifront/language-tools` `workspace:*`, `@volar/vscode` 2.4.28, `vscode-languageclient` 9.0.1, `@oxc-parser/binding-wasm32-wasi` 0.149.0.
5. Root devDependency `@types/vscode` 1.100.0 (exact, matches `engines.vscode`). `pnpm-workspace.yaml`: `peerDependencyRules.allowedVersions` for `@napi-rs/wasm-runtime>@emnapi/core` and `>@emnapi/runtime` = `2.0.0-alpha.3`, with a one-line reason.
6. `scripts/lib/bundle-vscode.mjs` (new): Vite `build()` (library mode, Rolldown) once per entry: CJS, SSR build (Node built-ins external, every dependency bundled), `source` condition, no minify, `checks.eval: false` (Volar's `eval('require')`), aliases `oxc-parser` → `oxc-parser/src-js/wasm.js` and `@oxc-parser/binding-wasm32-wasi` → resolved from `packages/vscode`. Outputs `dist/extension.cjs` (`vscode`, `typescript` external), `dist/server.cjs`, `dist/typescript-plugin.cjs` (`module.exports = factory`, `typescript` external), copies `dist/parser.wasm32-wasi.wasm`, rewrites `node_modules/multifront-typescript-plugin-pack/{package.json,index.js}`. Fails if the wasm binding version differs from the `oxc-parser` core resolves.
7. `scripts/devx.mjs` `vsix()`: delete `packages/vscode/dist`, write grammars, bundle, copy `LICENSE`, stage (every `files` entry plus a `package.json` with the pack as only dependency) in a temp folder, `vsce package <version> --no-update-package-json --out packages/vscode/multifront-vscode-<version>.vsix` there, delete the stage. Registry summary and SETUP.md updated (SETUP.md also says the command uses the `npm` CLI that ships with Node).

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`, ubuntu). They need child processes, the root `typescript` and the `npm` CLI `actions/setup-node` installs (vsce runs `npm list` in the stage, offline). No new CI infra. The `windows` job does not run these files (it runs `packages/core/test/context.spec.ts` and `packages/e2e/devx/` only); it still lints and typechecks the new files.

- `packages/e2e/editor/bundle.spec.ts` (new). `beforeAll` runs the real `pnpm devx vsix` in a temp repo copy (as `vsix.spec`'s version test does, so it never races `vsix.spec` over `packages/vscode/dist`) and unzips the `.vsix`: every check runs on what ships.
  1. Bundled server: the 2.6 cases again against `<unzipped>/extension/dist/server.cjs` (no `source` condition, `initializationOptions.typescript.tsdk` set): `Panel.ucf` `<style>` completion, hover, scss definition; every `invalid/` fixture's `multifront` diagnostics equal `checkBlocks()` (native oxc in the test, wasm in the bundle); the `untitled:` buffer; valid `Card.ucf` gets none.
  2. Pack alone: tsserver from the repo-root `typescript` link with symlinks preserved (no workspace package resolves next to it), `--globalPlugins multifront-typescript-plugin-pack`, `--pluginProbeLocations <unzipped>/extension`, no `source` condition, on `fixtures/apps/imports/`: the 2.9 `App.tsx` cases again (quickinfo shows `{ title: string; }`, definition lands in Card's `<react>`, a wrong prop is TS2322); the tsserver log shows the project entry failed to load and the pack loaded.
  3. Guard: same, with the project entry also loadable (2.9 setup: `--conditions=source`, probe `packages/e2e` first): the `App.tsx` cases pass, `mixed.ts` has exactly `target-not-built` on its vue line and one `mixed-frameworks` warning on its react line, and the log has the step-aside line. Fails without change 1.
- Shared cases: the 2.6 server cases and the 2.9 `App.tsx` cases move to `packages/e2e/editor/lib/cases.ts`, called by `server.spec.ts` / `tsserver.spec.ts` and `bundle.spec.ts`. `lib/lsp.ts`: `startLanguageServer(workspace, {server?, initializationOptions?})`. `lib/tsserver.ts`: `startTsserver` gains `source?`, `probeLocations?`, `isolated?`, `logFile?`. `lib/vsix.ts` (new): the temp repo copy, `readZip`, unzip, taken out of `vsix.spec.ts`.
- `vsix.spec.ts`: a stale file planted in the pack folder must not ship; expected entries add the four `dist/` files and the pack's `index.js` + `package.json`; the in-folder `vsce ls --no-dependencies` call goes (it cannot list what ships; the zip is checked); the packed manifest has `main`, `activationEvents` and the `typescriptServerPlugins` row; still no vsce warning.

## Docs

- `docs/architecture.md`: hosts table, VS Code extension row ("`grammar` at packaging time; bundles the server and the TypeScript plugin"); "Editor and types" gets a **Packaging** bullet (one universal `.vsix`, oxc through its wasm binding, the plugin pack in the extension's `node_modules`, the first plugin copy per project wins). No graphic change.
- `docs/milestones/m2-editor-basics.md`: 2.10 text as shipped (pack redirect, staged vsce, wasm, guard, unzipped-`.vsix` tests, the `Panel.ucf` hover), open item settled, `- Status: done`; 2.3's test sentence drops `vsce ls`; "Hands to later milestones": the `pnpm devx vsix` row and the plugin row (guard); Risks updated.
- `docs/milestones/m7-full-editor-support.md` 7.13: wasm chosen; vsce runs on the staged folder.
- `SETUP.md` vsix line, `scripts/lib/registry.mjs` summary. No `publicdocs/` page describes this yet.

## Fuzzing

Not a fuzz candidate: bundling adds no text-to-offset logic; bundle-vs-source parity over every fixture is the oracle.

## Out of scope

- Running the extension in a real VS Code (2.11). Marketplace fields and publishing (M7).
- Restarting the server when `typescript.tsdk` changes (M4). Hiding Node's "WASI is experimental" stderr line. Volar Labs.

## Done when

- `pnpm devx vsix` makes one `.vsix` with the grammars, `dist/extension.cjs`, `dist/server.cjs`, `dist/typescript-plugin.cjs`, the wasm and `node_modules/multifront-typescript-plugin-pack`.
- `bundle.spec.ts` passes all three groups; `vsix.spec.ts`, `server.spec.ts`, `tsserver.spec.ts` pass; `pnpm devx check` green.
- Docs above updated; the milestone step marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
