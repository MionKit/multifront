---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.3
---

# Milestone 2.3: VS Code extension package and `pnpm devx vsix`

## Problem

Step 2.2 generates the `.ucf` grammars in memory (`generateGrammar()` in `packages/vscode/src/grammar.ts`), but nothing
turns them into an extension VS Code can install. `packages/vscode/package.json` is only a workspace package (name,
`exports: ./grammar`, `@multifront/core` dependency): no `contributes`, no `engines`, no language, no icon. There is no
`pnpm devx vsix`.

Found while planning (the real `@vscode/vsce` tried on a scratch copy of `packages/vscode`):

- **vsce 4.0.0 is too new.** Released 2026-09-14; `pnpm-workspace.yaml` refuses versions younger than 30 days
  (`minimumReleaseAge: 43200`). The pin is **3.9.2** (2026-06-03). Its `keytar` and `@vscode/vsce-sign` install
  scripts stay blocked (`ignoreScripts: true`, `allowBuilds: {}`): vsce loads keytar only to publish
  (`out/store.js`), never for `package` or `ls`.
- **`engines.vscode` is required.** Without it `vsce ls` and `vsce package` stop with "Manifest missing field: engines".
- **Prompts on a terminal.** With no `repository` field or no `LICENSE` file, vsce asks "continue? [y/N]" when stdout
  is a TTY (`out/util.js:68` skips only when it is not). A local `pnpm devx vsix` would hang; both get added.
- **Version from `version.json` without touching `package.json`.** `vsce package <version> --no-update-package-json`
  sets the version in the packed manifest only (`versionBump` in `out/package.js` returns early).
- **`files` decides the content.** With a `files` list, `vsce ls` lists only `package.json` and those paths; a
  `LICENSE` not in `files` is left out.
- **The language icon may be an SVG.** vsce refuses an SVG only for the top-level Marketplace `icon`
  (`out/package.js:1009`), not for `contributes.languages[].icon`.
- **`generateGrammar()` runs in plain Node** under `node --conditions=source` (Node 26 strips the types, core loads from
  source). devx itself runs without that condition, so the grammar writer is a child process.
- **No `--cwd` in vsce.** It reads `package.json` from its working directory, so devx's `run()` gains a `cwd` option.
- **`LICENSE` is renamed in the package.** vsce packs it as `extension/LICENSE.txt`; `vsce ls` lists it as `LICENSE`.

## Plan

1. **Extension manifest**, `packages/vscode/package.json` (kept: name, version `0.0.0`, private, type, license,
   description, `exports`, `dependencies`). Added:
   - `engines: {"vscode": "^1.100.0"}`: no API used yet, so a wide floor; 2.10 pins `@types/vscode` at or below it.
   - No `publisher`: the id is an open M7 question (vsce packs without it).
   - `repository`: `{type: git, url: git+https://github.com/MionKit/multifront.git, directory: packages/vscode}`, the
     shape `packages/core` uses.
   - `files`: `["dist/syntaxes", "syntaxes/vendor/*/LICENSE", "syntaxes/vendor/sources.json", "icons",
     "language-configuration.json", "LICENSE"]`. The raw vendored JSON stays out: its renamed copy in `dist/syntaxes/`
     is what ships.
   - `contributes.languages`: `{"id": "ucf", "aliases": ["UCF", "ucf"], "extensions": [".ucf"],
     "configuration": "./language-configuration.json", "icon": {"light": "./icons/ucf.svg", "dark": "./icons/ucf.svg"}}`.
   - `contributes.grammars`: one entry per `generateGrammar()` file, in its order, `path` = `./dist/syntaxes/<file.path>`:
     root `{"language": "ucf", "scopeName": "source.ucf", "path", "embeddedLanguages"}`; `source.ucf.vue`,
     `source.ucf.svelte` as `{scopeName, path}`; the four `source.ucf.vue.vue.*` injection grammars with
     `"injectTo": ["source.ucf"]`.
   - Root `embeddedLanguages`, from each row's `grammar.languageId` and each `byLang` value (`styl` and `stylus` share a
     key): `meta.embedded.block.style` → `css`, `.style.scss` → `scss`, `.style.sass` → `sass`, `.style.less` → `less`,
     `.style.stylus` → `stylus`, `.style.postcss` → `postcss`, `meta.embedded.block.vue` → `vue`,
     `meta.embedded.block.react` → `typescriptreact`, `meta.embedded.block.svelte` → `svelte`. VS Code reads
     `embeddedLanguages` only from the language's root grammar.
2. **`packages/vscode/language-configuration.json`**, modelled on the Vue extension's: `comments.blockComment`
   `["<!--", "-->"]` (no line comment at the root; inside a block the embedded language's config applies); `brackets`
   `<!-- -->`, `< >`, `{ }`, `[ ]`, `( )`; `autoClosingPairs` `{}`, `[]`, `()`, `'` and `` ` `` (not in string or
   comment), `"` (not in string), `<!--` → ` -->` (not in comment or string).
3. **`packages/vscode/icons/ucf.svg`**: 16×16, three stacked rounded bars in the Vue, React and Svelte colours.
4. **`packages/vscode/LICENSE`**: the root MIT `LICENSE`, copied: vsce looks only in the extension folder.
5. **`pnpm devx vsix`**:
   - `scripts/lib/registry.mjs`: row `vsix`, summary "write the .ucf grammars to packages/vscode/dist/syntaxes/, then
     pack packages/vscode/multifront-vscode-<version>.vsix".
   - New `scripts/lib/write-grammar.mjs`: imports `generateGrammar` from `../../packages/vscode/src/grammar.ts`, empties
     `packages/vscode/dist/syntaxes/` (no stale file from a removed row), writes each file as
     `JSON.stringify(grammar, null, 2)` under its `path`. Runs only under `--conditions=source`.
   - `scripts/devx.mjs`: `run(entry, args, {cwd, node})` gains a working directory and node flags. The `vsix` handler
     runs the writer with `--conditions=source`, reads `version` from `version.json`, then
     `vsce package <version> --no-update-package-json --no-dependencies --out multifront-vscode-<version>.vsix` in
     `packages/vscode`.
   - Root `.gitignore`: `*.vsix`.
   - Root devDependency `@vscode/vsce` `3.9.2`, exact pin.
6. **Docs**: `SETUP.md` command list gets `pnpm devx vsix` plus one line on installing the `.vsix`. Milestone doc:
   `- Status: done` on 2.3, and the 2.3 Build text now says what keeps pnpm's links out (the `files` list, not a
   bundle: nothing is bundled before 2.10), the exact vsce call, and why `engines`, `repository` and `LICENSE` are there.
   `docs/milestones/m7-full-editor-support.md` 7.13 Build: `engines.vscode`, `repository` and `license` already come
   from M2, as does the version from `version.json` at pack time; M7 keeps `publisher`, `displayName`, the Marketplace
   `icon` and `categories`.

## Tests

`packages/e2e/editor/vsix.spec.ts`, area Editor, vitest project `e2e`. Runs on this host and in CI's `check` job
(`pnpm devx test`); needs only Node and the pnpm install (`@vscode/vsce` is a root devDependency). vsce `package` and
`ls` make no network call. No new CI infra (milestones README: "Editor: tsserver, LSP, vsix | nothing").

One `beforeAll` runs the real devx (`process.execPath scripts/devx.mjs vsix`, as `packages/e2e/devx/launch.spec.ts`
does), expects exit 0, then the real `vsce ls --no-dependencies` in `packages/vscode`, split into a set of paths.

- **Packed file**: `packages/vscode/multifront-vscode-<version.json version>.vsix` exists, is not empty, and was
  written by this run (its mtime is not older than the test start: an old gitignored `.vsix` would pass otherwise).
- **Content**: the list holds `package.json`, `icons/ucf.svg`, `language-configuration.json`, `LICENSE`,
  `syntaxes/vendor/sources.json` and `syntaxes/vendor/<name>/LICENSE` per key of `sources.json`; its `dist/syntaxes/*`
  entries equal exactly the `generateGrammar()` paths.
- **Manifest matches the registry**: `contributes.grammars` equals the list built from `generateGrammar()` (scopeName,
  `./dist/syntaxes/<path>`, `injectTo`); the root has `language: 'ucf'` and `embeddedLanguages` equal to the map built
  from `BLOCK_KINDS`. Every path the manifest names (grammars, language `configuration`, icon) is in the vsce list.
- **Same scopes as 2.2**: `GrammarFile[]` built from the manifest's `contributes.grammars`, each read from its
  `dist/syntaxes/` file; tokenizing `Card.ucf` deep-equals `tokenizeUcf(Card.ucf, generateGrammar())`. Spot checks:
  `export` in `<react>` is `keyword.control.export.tsx`; the `react`, `style.scss`, `vue` and `svelte` content scopes
  all show up.

## Docs

- `SETUP.md`: the command and how to install the `.vsix`.
- `docs/milestones/m2-editor-basics.md`, `docs/milestones/m7-full-editor-support.md`: as in Plan 6.
- `docs/spec.md`, `docs/plan.md`, `docs/architecture.md`: none; architecture already says the grammar is written at
  packaging time. `publicdocs/`: the milestone's docs writer.

## Fuzzing

None: a manifest and a pack command, no input space and no cheap oracle beyond the exact checks above.

## Out of scope

- Bundling, the extension entry, the server, the TypeScript plugin pack (2.10).
- `publisher`, `displayName`, the Marketplace `icon`, `categories`, a README, publishing (M7).
- `embeddedLanguages` for scopes inside the vendored Vue and Svelte grammars: `<vue>`/`<svelte>` are highlighting only.
- Starting a real VS Code (2.11).

## Decisions

- Publisher: left out until M7, which owns the id (orchestrator).
- `@vscode/vsce` pinned at 3.9.2, not 4.0.0: the 30-day release-age rule (orchestrator).

## Done when

- `pnpm devx vsix` writes `packages/vscode/dist/syntaxes/` and `packages/vscode/multifront-vscode-0.0.0.vsix`, with no
  prompt.
- `packages/e2e/editor/vsix.spec.ts` passes locally and in CI, and executes there.
- `pnpm devx check` passes.
- Milestone 2.3 has `- Status: done`; this spec is moved to `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
