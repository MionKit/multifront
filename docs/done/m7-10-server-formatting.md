---
type: feature
spec: full-plan
status: done
created: 2026-10-16
milestone: 7
step: 7.10
---

# Language server: formatting (format on save)

## Problem

Format Document in VS Code must give exactly what `mf-fmt` writes. Today the server has no `.ucf` formatter, yet it
already advertises `textDocument/formatting` (Volar turns it on because the CSS and Vue services can format). Volar
formats the root code, then each embedded code whose mappings have `format` on. Ours have it
(`ALL_FEATURES`, `packages/language-tools/src/mappings.ts:11`, on the `<react>` and `<style>` codes), and so do Vue's
(`codeFeatures.full` on the `VueVirtualCode` and its nested codes). Checked with the real server on
`lint-format/Messy.ucf`:

- with no tsdk, the CSS service reformats `<style lang="scss">` its own way (`opacity: .8` with no semicolon, blank lines);
- with a tsdk (VS Code always passes one), Vue's SFC formatter runs on the `vue` code, which covers the whole file with
  the non-Vue parts blanked: the edit **deletes the `<react>` and `<svelte>` blocks and the comments**.

## Decisions

- Publisher: `"publisher": "mionkit"` now, so the default formatter is `mionkit.multifront-vscode` (orchestrator, rule 2:
  Vue's extension id is its org as publisher, `Vue.volar`; MionKit is this repo's org). 7.13's field list drops
  `publisher`; open question 5 records `mionkit` for the Marketplace publisher and the Open VSX namespace.
- No fixture sweep (orchestrator, rule 3: the step's Test line asks for none; cases 1, 6 and 8 catch another service
  formatting a block).
- The bundled-server format case and the VS Code default-formatter check are in (orchestrator, rule 1: the Deliverable
  is about VS Code, and new behaviour has Vitest coverage).

## Plan (as shipped)

1. **Formatting off in every embedded code** (`packages/language-tools/src/mappings.ts`): `ALL_FEATURES` becomes
   `BLOCK_FEATURES`, every feature but `format`. New `withoutFormat(mappings)`: copies with `data.format: false`, cached
   per array in a `WeakMap`, never mutating the shared data objects. The root mapping (`languagePlugin.ts:52`) keeps
   `format: true`: Volar formats a code only when a mapping has it, and the root is where our plugin answers.
2. **Vue's codes** (`packages/language-tools/src/blocks/vue.ts`): `asBlockCode()` (was `ownStylesOnly()`) puts
   per-instance getters on the `VueVirtualCode`: `embeddedCodes` through `blockCodes()` (was `stripStyles()`), which
   drops Vue's style codes and copies every kept nested code with format-off mappings, and `mappings` through
   `withoutFormat()`. The `<svelte>` codes and `moduleTypes.ts` never set `format`.
3. **`packages/language-tools/src/server/workspace.ts`** (new): `workspaceRoot(fileName, folders)` moves here from
   `src/server.ts`, used by `emitOnSave` and the new plugin.
4. **`packages/language-tools/src/server/format.ts`** (new): `formatService(server)`, the `multifront-format` plugin,
   `capabilities: {documentFormattingProvider: true}`, no on-type provider. `provideDocumentFormattingEdits`:
   - only a `ucf` document with a `file` source URI, and only a range covering the whole document;
   - root: `workspaceRoot(file, server.workspaceFolders.all)`, else the file's own folder;
   - `findFormatConfig(file, root)`; an ignored file (`isIgnored`) gets nothing, as `mf-fmt` refuses one;
   - `formatUcf(file, buffer text, config)`; the client's `FormattingOptions` are ignored (the configs decide);
   - findings or unchanged text: `[]`; else one whole-document edit;
   - `missingSvelte`: `multifront: <MISSING_SVELTE>` logged once per root, edit still applied;
   - a throw (no oxfmt, a bad config): nothing, and `multifront: no formatting in <root> (<message>)` logged once per
     root until the reason changes or a format there succeeds.
5. **`src/server.ts`**: `formatService(server)` first in `services`.
6. **`packages/vscode/package.json`**: `"publisher": "mionkit"`, and `contributes.configurationDefaults`
   `"[ucf]": {"editor.defaultFormatter": "mionkit.multifront-vscode"}`. The suite.cjs comment about the publisher goes.

## Tests

On this host and in CI (`check` job's `pnpm devx test`, and the floor jobs). No new infra. Servers start with the tsdk,
as the extension does.

- **`packages/e2e/editor/server/format.spec.ts`** (new), helper `formatDocument()` in `editor/lib/lsp.ts`
  (open, optional buffer replace, `textDocument/formatting` with `{tabSize: 2, insertSpaces: true}`, edits applied):
  1. `lint-format/`: byte for byte the real `mf-fmt Messy.ucf` output on a second copy, one whole-document edit, no warning.
  2. Formatting the formatted buffer again: no edits.
  3. Unsaved buffer: equals `mf-fmt` on a copy whose file holds the same edited text.
  4. `Lint.ucf` (in `ignorePatterns`): no edits.
  5. A `<react>` that does not parse: no edits, no warning.
  6. A range request: no edits.
  7. `.oxfmtrc.json` not JSON: no edits, one warning with `mf-fmt`'s message; a second request logs nothing more.
  8. `lint-format-svelte/`: equals `mf-fmt`, the `<svelte>` block changed.
  9. No oxfmt (copy outside the repo): no edits, one warning, still one after a second request, the server still answers.
  10. oxfmt without svelte: equals `mf-fmt` there, `<svelte>` as written, one `missing-svelte` line.

  Red first: every case failed before the change. With any one format flag left on (ours, the `VueVirtualCode`'s
  own, Vue's nested codes), 6 to 10 of the 10 cases fail.
- **`packages/e2e/editor/bundle.spec.ts`**: the bundled `dist/server.cjs` formats `lint-format/Messy.ucf` as `mf-fmt`.
- **`packages/e2e/editor/vscode/suite.cjs`**: the extension is the default formatter of `[ucf]` files.
- **`packages/e2e/editor/virtualCode.spec.ts`**: the `<react>` and `<style>` pieces pin `format: false`.

## Docs

- `docs/architecture.md`, "Editor and types": a "Formatting in the editor" bullet.
- `docs/milestones/m7-full-editor-support.md`: 7.10 done and matched to what shipped; 7.13 drops `publisher`; open
  question 5 and the "same id" bullet name `mionkit`.
- spec 6.1 already says the server runs the same formatter; `publicdocs/` gets formatting from the docs writer.

## Fuzzing

None: the oracle is "the same function as `mf-fmt`", and the orchestrator declined a fixture sweep (Decisions).

## Out of scope

Lint diagnostics (7.11), packaging (7.13), range formatting and format on type, a VS Code notification on a format
error, formatting files other than `.ucf`.

## Done when

- Format Document on `lint-format/` and `lint-format-svelte/` gives byte for byte what `mf-fmt` writes, from source and
  from the bundled server; no oxfmt gives no edits and one log line; no svelte for oxfmt gives the edit and one line.
- Every case above is green in `pnpm devx check` and CI; step 7.10 marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
