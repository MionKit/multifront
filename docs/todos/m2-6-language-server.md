---
type: feature
spec: full-plan
status: ready
created: 2026-10-10
milestone: 2
step: 2.6
---

# Milestone 2.6: Language server

## Problem

After 2.5 `@multifront/language-tools` makes the `.ucf` virtual codes, but nothing serves them over LSP. In hybrid
mode (spec 6) tsserver does every TypeScript job (2.9); our own server does the rest: CSS / SCSS features in `<style>`
and our own diagnostics (`checkBlocks`) on the whole `.ucf` file. Other editors (Neovim, WebStorm) need a bin that
starts it with `--stdio`.

Found while planning (Volar 2.4.28 tarballs read in a scratch folder):

- `@volar/language-server/node.js` gives `createConnection`, `createServer`, `createSimpleProject`; the package has no
  `exports` map, so ESM imports `@volar/language-server/node.js` with the extension.
- `createSimpleProject(languagePlugins: LanguagePlugin<URI>[])` keys scripts by `URI`; `createUcfLanguagePlugin()` is a
  `LanguagePlugin<string>` (file names, as tsserver needs in 2.9). The server adapts it.
- Volar visits the root code as an embedded document too (`forEachEmbeddedDocument` yields `root`, languageId `ucf`)
  and maps its diagnostics through the 2.4 root mapping (1:1, `verification: true`). So a service that reports on
  languageId `ucf` reports on the `.ucf` file itself.
- `volar-service-css` 0.0.71 (2026-05-09) wraps `vscode-css-languageservice`; its default selectors already match our
  `css` / `scss` embedded codes. Optional peer `@volar/language-service ~2.4.0` (types only).
- Diagnostics are pulled when the client sends `capabilities.workspace.diagnostics` (VS Code's client does);
  otherwise pushed after a 250 ms delay.
- `@volar/test-utils` 2.4.28 `startLanguageServer(serverModule, cwd)` forks the module with `--stdio` and
  `env: process.env`, and sets `execArgv: ['--nolazy']` (inherited flags are replaced), so the source condition must
  come through `NODE_OPTIONS`.
- Nothing in the M2 server needs TypeScript: CSS and `checkBlocks` read none; core parses `<react>` with oxc-parser.
- oxc-parser loads a native binding per platform, and the server pulls in core. 2.10 bundles `dist/server.cjs`, and
  M7 7.13 says "the `.vsix` has no native binary and stays one file for every platform". Those do not fit together:
  2.10 must settle it (see Docs).

## Plan

1. **Dependencies** (`packages/language-tools/package.json`, via `pnpm add`, exact pins): `@volar/language-server`
   2.4.28, `volar-service-css` 0.0.71, `@volar/language-service` 2.4.28 (satisfies volar-service-css's optional peer,
   so its types resolve to the instance the server runs), `vscode-uri` 3.2.0 (the version Volar's `^3.0.8` resolves to
   under the 30-day age rule). Root devDependency `@volar/test-utils` 2.4.28, exact pin.
2. **Root code carries its split** (`src/languagePlugin.ts`, `src/types.ts`): `UcfVirtualCode extends VirtualCode
   { split: SplitResult }`; `createRootCode` returns it with the split it already made. Hosts split once; the
   diagnostics service reads it instead of splitting again. Not exported from `.`.
3. **`multifront` service** (`src/multifrontService.ts`): `createMultifrontService(): LanguageServicePlugin`, name
   `multifront`, capabilities `{diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false}}`.
   `provideDiagnostics(document)` acts only on languageId `ucf`: it finds the root code
   (`context.decodeEmbeddedDocumentUri(URI.parse(document.uri))`, `context.language.scripts.get(...)`) and returns
   `checkBlocks(root.split)` as LSP diagnostics: `range` from `document.positionAt(start)` to
   `document.positionAt(end)`, `severity` `error` → `DiagnosticSeverity.Error`, `warning` →
   `DiagnosticSeverity.Warning`, `code` the `DiagnosticCode`, `message` as is, `source: 'multifront'`.
4. **`startServer(): void`** (`src/server.ts`): `createConnection()` (reads `--stdio` from argv), `createServer`,
   `listen()`; `onInitialize(params)` → `server.initialize(params, createSimpleProject([byUri(plugin)]),
   [createCssService(), createMultifrontService()])`; `onInitialized(server.initialized)`,
   `onShutdown(server.shutdown)`.
   - `plugin = createUcfLanguagePlugin({compiler})`, `compiler = loadVueCompiler(root)` with `root` the first workspace
     folder (`params.workspaceFolders[0]`, else `rootUri`); no root or a throw → `undefined` (plain CSS modules
     only). This follows the 2.5 hand-off "2.6 and 2.9 pass its result as `EditorOptions.compiler`".
   - `byUri` (private) adapts the string-keyed plugin to `LanguagePlugin<URI>`: `getLanguageId(uri)` and
     `createVirtualCode(uri, languageId, snapshot)` call the plugin's with `fileName(uri)` (`uri.fsPath` for `file:`,
     else `uri.toString()`).
   - No TypeScript service and no `typescript` import (hybrid mode: tsserver serves `<react>`, 2.9).
5. **Subpath and bin** (`package.json`): `exports["./server"] = {source: './src/server.ts', types:
   './dist/server.d.ts', default: './dist/server.js'}`; `bin: {"multifront-language-server":
   "./bin/multifront-language-server.js"}` and `bin` in `files`. `bin/multifront-language-server.js` (ESM, shebang)
   imports `startServer` from the package's own `@multifront/language-tools/server` (self-reference, the 2.9
   `typescript-plugin/` pattern) and calls it: installed it runs `dist/`; in the workspace under
   `--conditions=source` it runs `src/` through Node's type stripping.
6. **Package text**: `package.json` description and README line also name the language server.

## Tests

All on this host and in CI's `check` job (`pnpm devx test`): Node and the pnpm install only, the server is a child
process. No new infra (milestones README: "Editor: tsserver, LSP, vsix | M2 | nothing").

- **Helper `packages/e2e/editor/lib/lsp.ts`**: `startLanguageServer(workspace): Promise<LanguageServer>`. Runs
  `@volar/test-utils`' `startLanguageServer` on the real bin as installed
  (`packages/e2e/node_modules/@multifront/language-tools/bin/multifront-language-server.js`), with `--conditions=source`
  added to `NODE_OPTIONS` only while the child is forked. Then `initialize(workspace URI, {}, {textDocument:
  {diagnostic: {}}, workspace: {diagnostics: {}}})`, so diagnostics are pulled as in VS Code. `LanguageServer` = the
  test-utils handle plus `stop()` (shutdown, `exit`, kill).
- **`packages/e2e/editor/server.spec.ts`**, workspace `fixtures/components`, every position found from the fixture
  text:
  - `<style>` of `Panel.ucf`: completion inside `padding` lists `padding`; hover on `padding` has CSS docs naming it,
    with its range on that word in the `.ucf` file; definition on `$pad` in `padding: $pad` lands in `Panel.ucf` on
    the `$pad` of `$pad: 1rem;`.
  - every fixture in `listComponents('invalid')`: the pulled diagnostics with `source: 'multifront'` equal
    `checkBlocks(splitBlocks(source, filename))`, compared as `{code, severity, message, range}` (range from the
    offsets through the opened `TextDocument`), both sorted.
  - `Card.ucf` (valid) gets no `multifront` diagnostic.
  - the TypeScript cases are tsserver tests (2.9).
- Each check is confirmed to fail without its behaviour (service not registered, an off-by-one range, CSS service
  dropped).
- `virtualCode.spec.ts` and `builtTypes.spec.ts` stay green with `split` on the root code and the new subpath.

## Docs

- `docs/milestones/m2-editor-basics.md`: `- Status: done` on 2.6; step text and "Hands to later milestones" match what
  shipped (`source: 'multifront'`, the helper's `stop()`, the TypeScript line: the server never bundles or imports
  TypeScript; the first service that needs it (M4) loads it from `initializationOptions.typescript.tsdk`).
- `docs/milestones/m2-editor-basics.md` 2.10 Build: an open item 2.10 must settle: the bundled server loads core, so
  oxc-parser's native binding; either oxc's wasm binding or a per-platform `.vsix`, with the bundle test proving the
  server loads.
- `docs/milestones/m7-full-editor-support.md` 7.13: "no native binary ... one file for every platform" depends on that
  2.10 decision. M4's doc: check it says nothing else about where the server's TypeScript comes from.
- `docs/plan.md:86` says the server serves `<react>` too: it becomes `<style>` (CSS, SCSS) and our own diagnostics,
  `<react>` features from tsserver (hybrid mode).
- `docs/architecture.md`, `docs/spec.md`, `SETUP.md`: no change. `publicdocs/`: the milestone's docs writer.

## Out of scope

- TypeScript features (2.8, 2.9), the extension and the bundle (2.10), the VS Code harness (2.11).
- `style-compile-error` in the editor, less / sass / stylus / postcss services, formatting, linting (M7).
- A fuzz test: the milestone puts none in this step.

## Decisions

- The M2 server never imports `typescript` and uses `createSimpleProject`; the first service that needs TypeScript
  (M4) loads it from `initializationOptions.typescript.tsdk`; 2.10 still passes the tsdk (orchestrator).
- oxc-parser's native binding in the bundled server is on this milestone's path: an open item in 2.10's Build text, and
  M7 7.13's "no native binary" line depends on it. No todo file (orchestrator).
- No fuzz test: 2.6 has none (orchestrator).

## Done when

- `multifront-language-server --stdio` serves completion, hover and definition in `<style>` and `checkBlocks`
  diagnostics on the `.ucf` file, over real LSP.
- `server.spec.ts` passes on this host and runs in CI; `pnpm devx check` passes.
- Milestone docs and plan.md match what shipped; this spec is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
