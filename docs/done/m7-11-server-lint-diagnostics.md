---
type: feature
spec: full-plan
status: done
created: 2026-10-16
milestone: 7
step: 7.11
---

# Language server: lint diagnostics

## Problem

VS Code must show the oxlint findings `mf-lint` prints, in every target block, live as the user types. Today the
server's only diagnostics are ours (`multifrontService`, `packages/language-tools/src/multifrontService.ts:17`).
`lintUcf(files, root)` (`packages/language-tools/src/lint/index.ts:152`) already returns `UcfLintDiagnostic`s in `.ucf`
offsets, with `url` and `help`, from any `SplitResult`, so it can lint the in-memory buffer.

Two Volar facts shape the plan (`@volar/language-server` / `@volar/language-service` 2.4.28):

- **Pull mode, cache per version.** The server runs in pull mode (no plugin has `interFileDependencies`, VS Code
  pulls). `provideDiagnostics` (`language-service/lib/features/provideDiagnostics.js`) caches each plugin's result per
  document version, cleared only on `workspace/didChangeConfiguration`, never on a file change. A re-pull after
  `.oxlintrc.json` changes on disk would return the stale result. `interFileDependencies: true` skips the cache but
  moves the whole server to push mode. Instead, on a config change the plugin calls `server.project.reload()` (the
  simple project drops and rebuilds its language service, caches included), then
  `server.languageFeatures.requestRefresh(false)`, which sends `workspace/diagnostic/refresh` so the client pulls again.
- **No file watcher until one is asked for.** `server.fileWatcher.onDidChangeWatchedFiles` fires only after
  `server.fileWatcher.watchFiles(patterns)` hooks `workspace/didChangeWatchedFiles` and dynamically registers the globs
  with a client that supports it (VS Code does). Nothing in our server calls it today.

oxlint's own language server (`oxlint --lsp`, pinned 1.82.0, on a `.ts` file) sends `code`, `codeDescription.href`
(the rule URL) and `message` as `<message>\nhelp: <help>`. Same shape here, so a `.ucf` diagnostic reads like a `.ts` one.

## Decisions

- Help in the message as `<message>\nhelp: <help>` (orchestrator, rule 3: fewer surprises, a `.ucf` diagnostic reads
  like oxlint's own server output; the 7.11 Build line gains a clause naming it).
- Config change = `server.project.reload()` plus `requestRefresh(false)` (orchestrator, rule 1: the step's Build line
  "and again when `.oxlintrc.json` changes"; rule 4 picks reload over moving the whole server to push mode).
- The bundle.spec case is in (orchestrator, rule 1: the Deliverable reads "oxlint findings show in VS Code", and VS
  Code runs the bundled server; same call as 7.10).
- The once-per-root log line on a missing oxlint or a bad config is in (orchestrator, rule 3: clearer error; matches
  7.10's formatting rule).

## Plan (as shipped)

1. **`packages/language-tools/src/server/lint.ts`** (new): `lintService(server)`, the `multifront-lint` plugin,
   `capabilities: {diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false}}`.
   `provideDiagnostics(document)`:
   - only a `ucf` document with a `file` source URI (`context.decodeEmbeddedDocumentUri`, as `format.ts`), and its root
     code from `ucfRoot(context, document.uri)` (`multifrontService.ts:9`);
   - folder: `workspaceRoot(file, server.workspaceFolders.all) ?? dirname(file)`, where oxlint loads from, as oxfmt;
   - `lintUcf([root.split], folder)`: the buffer's split, not the file on disk. A split with errors, or a file its
     config's `ignorePatterns` exclude, gives nothing (`lintUcf` skips both, as `mf-lint` does);
   - each `UcfLintDiagnostic` → `{range: positionAt(start)..positionAt(end), severity, code, codeDescription: {href: url}
     (when url), source: 'oxlint', message: help ? `${message}\nhelp: ${help}` : message}`; severity error 1, warning 2,
     advice 3 (no test: oxlint gives `advice` for no configured rule, its config severities being off, warn and error;
     the map is total over `UcfLintDiagnostic['severity']`);
   - a throw (no oxlint, a config oxlint rejects, no temp folder): no lint diagnostics, and
     `multifront: no linting in <folder> (<lintUcf's message>)` logged once per folder until the reason changes or a lint
     there succeeds (the rule of `multifront: no formatting in …`).

   Also in `lintService(server)`:
   - `server.onInitialized(() => server.fileWatcher.watchFiles(['**/.oxlintrc.json', '**/.oxlintrc.jsonc']))`, a
     rejected registration logged (`multifront: no .oxlintrc.json watcher (…)`), never left unhandled;
   - `server.fileWatcher.onDidChangeWatchedFiles`: any created, changed or deleted file of those names →
     `server.project.reload()`, then `server.languageFeatures.requestRefresh(false)`.
2. **`packages/language-tools/src/server.ts:135`**: `lintService(server)` joins `services`, after `multifrontService`.
3. On open and on every buffer change: the client pulls (VS Code paces the pulls), and Volar's cache gives one oxlint
   run per document version.

## Tests

All on this host and in CI (`check` job's `pnpm devx test`, and the floor jobs); they need oxlint (a root
devDependency), nothing new. Servers start with a tsdk, as the extension does.

- **`packages/e2e/editor/lib/lsp.ts`**: the client capabilities match VS Code's: `workspace: {diagnostics,
  inlayHint, semanticTokens: {refreshSupport: true}, didChangeWatchedFiles: {dynamicRegistration: true}}` (Volar's
  refresh also refreshes inlay hints and semantic tokens, and warns once for a client that cannot; the three refresh
  requests are answered). `LanguageServer` gains `registrations` (each `client/registerCapability` the server sent,
  answered) and `nextDiagnosticRefresh()` (resolves on the next `workspace/diagnostic/refresh`). Shared now:
  `openUcf(server, file, text?)` (open, optional buffer replace, also under `formatDocument()`), `loggedWarnings(server,
  from)` (also under `formatting()`'s `warnings`) and the `Document` type (`cases.ts` imports it).
- **`packages/e2e/editor/lib/format.ts`**: `formatting()` serves both specs: a server on one copy, a second copy for the
  real commands.
- **`packages/e2e/editor/lib/lint.ts`** (new): `lintDiagnostics(server, file, text?)` pulls and keeps the
  `source: 'oxlint'` diagnostics in `.ucf` order (oxlint lints the block files in parallel, so its order is not the
  file's, so `cases.ts`'s `byStart` sorts them); `mfLintFindings(root, file)` runs the real `mf-lint --format json`; `asLintPoint()` turns a finding into the
  LSP `{code, range, severity}`.
- **`packages/e2e/editor/server/lint.spec.ts`** (new). Real server over LSP on a `copyApp('lint-format')` copy
  (`formatting()`), the real `mf-lint --format json` on the same copy's files on disk:
  1. Open `Lint.ucf`, pull: the oxlint diagnostics equal the `mf-lint` findings for `Lint.ucf`: `code`, range
     (`line` / `column` to `end`, minus 1), severity (error 1, warning 2), in order; each with `source: 'oxlint'`, its
     rule's `codeDescription.href`, a message that is the finding's message, `\nhelp: ` and the help. The text before
     each `debugger;` is not ASCII. No warning logged.
  2. A `<vue>` script that does not parse (`Broken.ucf`): the diagnostics equal `mf-lint`'s, and oxlint's parse error
     (no code, no URL, no help) has exactly oxlint's message, `Unexpected token`, and no `code` or `codeDescription`.
  3. The server registered a watcher with the globs `**/.oxlintrc.json` and `**/.oxlintrc.jsonc`.
  4. A real `didChange` blanks the `debugger;` of `<vue>` (spaces, so no line moves): only that diagnostic goes, the
     other three keep their ranges;
     the file on disk is unchanged (`mf-lint` still reports four).
  5. `Lint.ucf` of the second copy, outside every workspace folder: linted from its own folder, as `mf-lint` there.
  6. `.oxlintrc.json` edited on disk to turn `no-debugger` off, then `workspace/didChangeWatchedFiles` as VS Code sends
     it: the server asks for a diagnostic refresh, and the next pull holds only `no-unused-vars`. Config restored.
  7. No oxlint diagnostics for `Clean.ucf`, a copy of `Lint.ucf` under `old/` (in `ignorePatterns`), an untitled
     document, or a copy of `components/invalid/DuplicateReact.ucf`, which keeps its multifront `duplicate-target`
     diagnostics. Nothing logged.
  8. An `.oxlintrc.json` that is not JSON (written, watched change, refresh awaited): no oxlint diagnostics,
     `multifront: no linting in <folder> (oxlint: …)` logged once over two pulls; config restored and change sent: the
     findings come back; broken again: a second line. Passes when run alone too.
  9. No oxlint (`copyAppOutside`, `assertNotInstalled(root, 'oxlint')`): no oxlint diagnostics, one line
     `multifront: no linting in <folder> (oxlint is not installed in <folder>; add it to devDependencies)` over two pulls,
     the pull still answers (`kind: 'full'`), the server process alive.

  Red first: without the plugin every case but 7 fails; without the reload cases 6 and 8 fail (stale cache); help
  always appended fails 2; the failure never cleared fails 8.
- **`packages/e2e/editor/bundle.spec.ts`**: the bundled `dist/server.cjs` gives the same oxlint diagnostics on
  `Lint.ucf` of `lint-format/` as `mf-lint`, so the bundle left nothing out of the lint path.

## Found on the way

- oxlint's parse error has no `code`, so `mf-lint` prints `error undefined (react)` and its JSON finding lacks the
  required `code`. That is `mf-lint`'s output (7.8), not the server's: filed as a guidelines todo in this PR.

## Docs

- `docs/architecture.md`, "Editor and types": a "Linting in the editor" bullet after `mf-lint`.
- `docs/milestones/m7-full-editor-support.md`: 7.11 matched to what shipped (pull mode, reload plus refresh on a config
  change, help in the message, the log line, the bundle case), then `- Status: done`. No "Hands to later milestones"
  name changes.
- spec 6.1 already says the server runs the same linter; `publicdocs/` names no lint behaviour.

## Fuzzing

None: the oracle is "the same function as `mf-lint`", as in 7.10.

## Out of scope

Lint code actions and `--fix`, push-mode diagnostics, `relatedInformation` from oxlint's labels, linting untitled
documents, type-aware rules, packaging (7.13).

## Done when

- In the real server, oxlint diagnostics on `Lint.ucf` match `mf-lint`, from source and from the bundled server; they
  follow unsaved edits and `.oxlintrc.json` changes; a missing oxlint or a bad config logs one line.
- Every case above green in `pnpm devx check` and CI; step 7.11 marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
