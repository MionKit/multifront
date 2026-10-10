# Milestone 7: Full editor support

## Goal

A `.ucf` file gets the same checks as any other source file, on the command line and in VS Code:

- `mf-tsc` type-checks every target of every `.ucf` file, so a block that breaks one framework fails CI.
- The `<svelte>` block gets markup completions: HTML tags, Svelte elements, directives, `{#if}` style blocks and component props.
- `mf-fmt` formats each block with oxfmt's `format()` and puts the file back together.
- `mf-lint` lints each block with oxlint and maps every finding back to the right line of the `.ucf` file.
- The language server runs the same formatter and linter, so VS Code shows what the command line shows (format on save, diagnostics).
- The VS Code extension is packaged with `language-tools` bundled and published to the VS Code Marketplace and Open VSX.

Spec: sections 5, 6 and 6.1. Plan: milestone 7.

### Decision: the commands in this repo's CI

- **`mf-tsc`: yes.** Every valid fixture must type-check in every target it has. A fixture that fails one framework is a bug in the fixture or in our tools, and CI should say so.
- **`mf-lint`: yes.** Every valid fixture must have zero oxlint errors under the repo's own `.oxlintrc.json`. Warnings are allowed.
- **`mf-fmt`: no, not over the repo.** AGENTS.md says `pnpm devx format` is the only formatter run and its scope never widens. Fixtures also hold deliberately odd code (splitter edge cases like `a < b` and `</react>` in a string) that a formatter would erase. `mf-fmt` runs in CI only inside its own tests, on copies of its own fixtures.
- **How:** both run as an e2e test in `packages/e2e/editor/` (step 7.12), so `pnpm devx test`, and therefore `pnpm devx check` and CI, runs them. No new devx command.

### Decision: lint and format read the block's own text

architecture.md says oxlint and oxfmt run on the `build` file. The build file of `<react>` carries the scope stamp and the injected `$style` import. Formatting that and writing it back would put generated code into the user's file. Linting it gives findings on code the user never wrote. So `mf-fmt` and `mf-lint` read the **block's own text** and give it the **file ending of its build file** (`.tsx`, `.vue`, `.svelte`), or the `lang` ending for a `<style>` block (`.css`, `.scss`, `.less`). Step 7.6 updates the one line in architecture.md.

## Needs from earlier milestones

From M1 (splitter, block kinds, styles, e2e package):

- `splitBlocks(source, filename)` from `@multifront/core`, returning blocks with `{ type, attrs, content, start, end, contentStart, contentEnd }` and errors with `{code, message, line, column}`.
- `BlockKind`, `BLOCK_KINDS` and `getBlockKind(tag)` from `packages/core/src/blocks/index.ts` (order `style, vue, react, svelte`), and `VirtualFile['ext']`.
- The private `packages/e2e` package (Vitest project `e2e`) with `packages/e2e/editor/`, `packages/e2e/consumer/`, `fixtures/components/` and `fixtures/apps/`.
- The fixture helpers in `packages/e2e/fixtures/index.ts`: `FIXTURES_DIR`, `componentPath()`, `listComponents()`, `copyApp(name)` (a fresh copy under `packages/e2e/.tmp/`). Every "temp copy" below is a `copyApp()` copy.
- The invalid fixtures in `fixtures/components/invalid/` and the saved fuzz cases in `fixtures/components/fuzz/`, which the CI gate of 7.12 leaves out.

From M2 (editor basics):

- `@multifront/language-tools` with the Volar language plugin, the `./typescript-plugin` subpath and the `./server` subpath.
- The per-file virtual scripts named as in spec 5 (`Card.ucf.react.tsx`) and the language plugin's `typescript` hooks (`getServiceScript`), so `mf-tsc` can reuse the plugin as is.
- Where the TypeScript plugin reads its options (the default `framework` and `importers`). This document assumes the plugin entry in `compilerOptions.plugins` of `tsconfig.json`, named `@multifront/language-tools/typescript-plugin`. `mf-tsc` reads the same place.
- The `editor(block, ctx)` halves in `packages/language-tools/src/blocks/` (`react.ts`, `style.ts`), returning embedded codes with Volar mappings (`CodeInformation`).
- The LSP test harness in `packages/e2e/editor/` that spawns the real server over stdio and sends real requests (open, change, completion, hover, diagnostics).
- `packages/vscode`: `.ucf` language id, the TextMate grammar, the extension entry that starts the server and registers the TypeScript plugin, and its bundler setup (the one package not built by plain `tsc`), runnable in an Extension Development Host.

From M3 (React target and imports):

- `resolveTarget(importer, attribute, options)` in `@multifront/core`, and the TypeScript plugin's attribute-aware resolution built on it (spec 5), as a function `mf-tsc` can call from a program host. M2 names it `resolveUcfImport(ts, literal, containingFile, options)`.
- The React demo fixture app under `packages/e2e/fixtures/apps/`.

From M4 (Vue target):

- The `<vue>` block in the editor through `@vue/language-core`, and the `Card.ucf.vue.ts` virtual script from `types(block, ctx)`.
- That `Card.ucf.vue.ts` holds the template type-check code too (what `@vue/language-core` generates), not only the export shape. Otherwise `mf-tsc` cannot see a template error.
- The fixture app that imports the same `.ucf` file as React and as Vue.

From M5 (library build):

- The pack-and-install helper of `packages/e2e/consumer/` (packs a workspace package into a tarball and installs it into a fresh real project). Step 7.12 reuses it for `@multifront/language-tools`.

From M6 (Svelte target):

- `Card.ucf.svelte.ts` through `svelte2tsx`, from `types(block, ctx)`, with the markup expressions in it (what `svelte2tsx` generates) and a mapping back to the `<svelte>` block.
- `packages/language-tools/src/blocks/svelte.ts` `editor(block, ctx)`, returning the `svelte2tsx` TypeScript code as embedded code.
- The Svelte fixture app, and `svelte` installed in `packages/e2e` (oxfmt needs `svelte/compiler` to format Svelte, step 7.7).
- `fixtures/components/Card.ucf` with all three target blocks and its `<style module>` (M1 made it; M4 and M6 fill its `<vue>` and `<svelte>` blocks). The exit test uses it.

Outside the milestones (new pinned devDependencies, added in the step that needs them, subject to the 30-day release age rule):

- `@volar/typescript` (its `runTsc`, the same entry `vue-tsc` uses), `volar-service-html`, `@vscode/vsce`, `ovsx`, `@vscode/test-electron`.
- `oxfmt` and `oxlint` as optional `peerDependencies` of `@multifront/language-tools` (ranges), so a project's own versions are used.
- A VS Code Marketplace publisher and an Open VSX namespace with the same id, and the repository secrets `VSCE_PAT` and `OVSX_PAT` (step 7.14). A maintainer creates these once by hand.

## Steps

### 7.1 `mf-tsc` for the React target and its importers

- Build: `packages/language-tools/src/tsc/index.ts` and the bin `mf-tsc` (`packages/language-tools/bin/mf-tsc.js`, listed under `bin` in its `package.json`). It calls `runTsc` from `@volar/typescript` with `extraSupportedExtensions: ['.ucf']`, our Volar language plugin, and `resolveUcfImport` so imports follow spec 4.2 (attribute, then importer, then the default target from the tsconfig plugin entry). Check only: an emit flag (`--declaration`, `--outDir` without `--noEmit`) is an error that points to the library build of M5. Output and exit codes are the same as `tsc`.
- Deliverable: `mf-tsc -p tsconfig.json` type-checks `.ts` / `.tsx` files that import `.ucf` files, and the `<react>` block of every `.ucf` file the tsconfig includes. Errors print with `.ucf` lines and columns.
- Test: area Editor, `packages/e2e/editor/tsc/react.spec.ts`. New fixture app `packages/e2e/fixtures/apps/types-every-target/` (valid) and `packages/e2e/fixtures/apps/types-broken/` with `ReactBreaks.ucf` (a `<react>` block that passes a number to a `string` prop) and `main.tsx` passing a wrong prop to a valid `.ucf`. The test spawns the real `mf-tsc` on both: exit 0 on the valid app; on the broken one, exit 1 and the exact `file(line,col): error TSxxxx` lines. Each reported position is checked against the fixture text (the slice at that line and column is the bad expression).

### 7.2 `mf-tsc` checks every target of every `.ucf` file

- Build: the language plugin's `typescript.getExtraServiceScripts` returns every target's virtual script of a `.ucf` file (`Card.ucf.vue.ts`, `Card.ucf.svelte.ts`, plus whichever M2 did not make the main script), so `tsc` checks them all. A diagnostic in a generated part with no mapping is reported on the block's opening tag, never dropped.
- Deliverable: one `mf-tsc` run fails when any one target of any file is broken, even when nothing imports that target.
- Test: area Editor, `packages/e2e/editor/tsc/every-target.spec.ts`. Adds to `types-broken/`: `VueBreaks.ucf` (valid `<react>` and `<svelte>`, a template type error in `<vue>`), `SvelteBreaks.ucf` (same, error in `<svelte>` markup), `OnlyReactExport.ucf` plus `main.ts` importing its named export `with { framework: 'vue' }` (spec 11, "Different exports per target"). Real `mf-tsc`: each error lands inside the right block, on the right line. The valid `types-every-target/` app (all three targets) still exits 0. The same broken files opened in the real tsserver with our plugin (M2 harness, hybrid mode) give the same codes at the same positions.

### 7.3 `mf-tsc` also checks `.vue` importers

- Build: `mf-tsc` adds `@vue/language-core`'s language plugin for `.vue` files (already a dependency since M4), so a `Page.vue` that imports `./Card.ucf` is checked in the same program. One command replaces `vue-tsc` in a project that uses `.ucf` files.
- Deliverable: `mf-tsc` type-checks `.vue` files, and their `.ucf` imports resolve to the Vue target.
- Test: area Editor, `packages/e2e/editor/tsc/vue-importer.spec.ts`. Adds `Page.vue` to `types-every-target/` (valid) and `BadPage.vue` to `types-broken/` (passes a wrong prop to a `.ucf` component in its template). Real `mf-tsc`: the valid app exits 0; the broken one reports the error in `BadPage.vue` at the prop.

### 7.4 Svelte markup completions: tags, Svelte elements, directives, blocks

- Build: in `packages/language-tools/src/blocks/svelte.ts`, `editor(block, ctx)` adds an `html` embedded code: the block text with `<script>` contents and every `{...}` expression replaced by spaces, so offsets stay 1:1. Its mapping turns on completion only (no HTML diagnostics, no HTML formatting). The server adds `volar-service-html` with a Svelte data table (`packages/language-tools/src/blocks/svelteHtmlData.ts`): the `svelte:*` elements (`svelte:window`, `svelte:document`, `svelte:body`, `svelte:head`, `svelte:element`, `svelte:boundary`, `svelte:options`) and the directive prefixes (`bind:`, `class:`, `style:`, `use:`, `transition:`, `in:`, `out:`, `animate:`). A small service plugin (`multifront-svelte-markup`) completes the template blocks after `{#`, `{@` and `{:` (`{#if}`, `{#each}`, `{#await}`, `{#key}`, `{#snippet}`, `{@render}`, `{@html}`, `{@const}`, `{@debug}`, `{:else}`, `{:then}`, `{:catch}`).
- Deliverable: typing in the `<svelte>` markup completes HTML tags and attributes, Svelte elements, directives and blocks. Expressions inside `{...}` keep their TypeScript completions from M6's `svelte2tsx` code.
- Test: area Editor, `packages/e2e/editor/server/svelte-markup.spec.ts`. New fixture `packages/e2e/fixtures/apps/svelte-markup/Toolbar.ucf`. Through the real server over LSP the test types real edits (`didChange`) and asks for completions: `<sv` lists `svelte:window`, `<input bi` lists `bind:value`, `{#` lists `if` and `each`, `{ti` inside markup lists the `title` prop (that one comes from tsserver with our plugin, hybrid mode; the rest from our server). Each suggested item is then inserted into a copy of the block and parsed with the real `svelte/compiler` `parse`, which must not throw, so we never suggest invalid Svelte.

### 7.5 Svelte component props in markup

- Build: the `<svelte>` editor mapping also maps the attribute area of a component start tag (`<Icon |>`) to the props object that `svelte2tsx` generates for that component, completion only. Props of a child imported from another `.ucf` file come from that file's Svelte virtual script (spec 4.1).
- Deliverable: `<Icon ` in the markup completes `Icon`'s props, with their types in the details.
- Test: area Editor, `packages/e2e/editor/server/svelte-props.spec.ts`. Adds `Icon.ucf` (Svelte props `name: string`, `size?: number`) to `svelte-markup/`, imported by `Toolbar.ucf`. Real server, real edit typing `<Icon `: the list holds `name` and `size` with their types. Then the test types `<Icon nme="x"/>` and the real server reports the unknown prop on `nme` (the error path through the same mapping).

### 7.6 `mf-fmt`: oxfmt's `format()` block by block

- Build: `packages/language-tools/src/format/index.ts` exports `formatUcf(fileName, source, config)`, and the bin `mf-fmt [--check] [paths…]`. Steps per file: `splitBlocks`, then for each block call oxfmt's `format(blockFileName, block.content, config)`, then replace only the text between `contentStart` and `contentEnd`. Text outside the blocks stays byte for byte. `blockFile(block)` in `packages/language-tools/src/blocks/blockFile.ts` names the block file `Card.ucf.<tag><ext>`: the ending of the kind's build file (`.tsx`, `.vue`, `.svelte`), or the `<style lang>` ending (`.css`, `.scss`, `.less`). Only endings oxfmt formats are sent (`.tsx`, `.vue`, `.css`, `.scss`, `.less`); any other block stays as written. Block text is written flush left, one newline after the opening tag and one before the closing tag. Config is the project's own: the nearest `.oxfmtrc.json` / `.oxfmtrc.jsonc` (and `.editorconfig`), `overrides` matched against the block file path, `ignorePatterns` against the real `.ucf` path. A block that fails to parse leaves the whole file unchanged and prints the error at its `.ucf` position.
- Deliverable: `mf-fmt` formats `.ucf` files in place; `mf-fmt --check` lists unformatted files and exits 1.
- Test: area Editor, `packages/e2e/editor/format/mf-fmt.spec.ts`. New fixture app `packages/e2e/fixtures/apps/lint-format/` with its own `.oxfmtrc.json` and `Messy.ucf` (unformatted `<react>`, `<vue>`, `<svelte>`, `<style lang="scss">`). On a temp copy, the real `mf-fmt`:
  1. Each formatted block equals what the real oxfmt CLI prints for the same text (`oxfmt --stdin-filepath <block file path>` in the same folder), so our config handling matches the CLI.
  2. The `<svelte>` block and everything outside the blocks are unchanged.
  3. A second run changes nothing, and `--check` exits 0.
  4. The formatted copy still passes the real `mf-tsc`, and the real Vite build of each target (M3, M4, M6 plugins) still succeeds.
  5. `--check` on the untouched fixture exits 1 and names `Messy.ucf`.

  A loop over `BLOCK_KINDS` checks that `blockFile` names a file for every tag, so a new block kind cannot skip it.

### 7.7 `mf-fmt`: Svelte blocks follow oxfmt's `svelte` option

oxfmt 0.67.0 formats `.svelte` files when the config sets `svelte` (true or an object) and `svelte` is installed. It is off by default.

- Build: `formatUcf` adds `.svelte` to the endings it sends when the resolved config turns `svelte` on. If `svelte/compiler` cannot be loaded, `mf-fmt` prints one warning per run and leaves the `<svelte>` blocks as written. Updates spec 6.1, whose "not Svelte" line is out of date.
- Deliverable: a project that turns on oxfmt's Svelte formatting gets its `<svelte>` blocks formatted too; any other project keeps them as written.
- Test: area Editor, `packages/e2e/editor/format/svelte.spec.ts`. New fixture `packages/e2e/fixtures/apps/lint-format-svelte/` with `.oxfmtrc.json` `{"svelte": true}` and a copy of `Messy.ucf`. Real `mf-fmt` on a temp copy: the `<svelte>` block now equals the real oxfmt CLI output for the same text (`--stdin-filepath Messy.ucf.svelte.svelte`), and the real Svelte build (M6) of the result still succeeds. The `lint-format/` fixture, without the option, keeps it as written (7.6 test still green).

### 7.8 `mf-lint`: per-block files through oxlint, positions mapped back

- Build: `packages/language-tools/src/lint/index.ts` exports `lintUcf(files, {root})`, and the bin `mf-lint [--format default|json] [--deny-warnings] [paths…]`. oxlint has no stdin mode, so per run:
  1. Make a temp folder (`os.tmpdir()`), and write each target block's text there as `<relative path>/Card.ucf.<tag><ext>` (from `blockFile`), keeping the path relative to the project root so the config's `overrides` globs still match. `<style>` blocks are skipped: oxlint does not lint CSS.
  2. Write a wrapper `.oxlintrc.json` in the temp folder: `{"extends": ["<the project's nearest .oxlintrc.json>"], "globals": {"$style": "readonly"}}`, plus each named module (`<style module="classes">` adds `classes`). The project config is never changed.
  3. Run the project's own `oxlint -c <wrapper> -f json` once over all block files, from the temp folder.
  4. Map each finding back: `.ucf` offset = block `contentStart` + `labels[].span.offset`; line and column are recomputed on the `.ucf` text. For `.vue` and `.svelte` block files oxlint already reports offsets from the start of the file, so the same sum holds.
  5. Delete the temp folder in a `finally`.

  JSON output keeps oxlint's shape (`diagnostics[]` with `message`, `code`, `severity`, `url`, `help`, `filename`, `labels[].span`), with `filename` set to the `.ucf` path. Exit 1 on any error (or any warning with `--deny-warnings`), like oxlint. A splitter error is printed at its position and counts as an error.

- Deliverable: `mf-lint` reports oxlint findings for every target block, at the right `.ucf` line and column.
- Test: area Editor, `packages/e2e/editor/lint/mf-lint.spec.ts`. Adds `.oxlintrc.json` (with `no-debugger` and `no-undef` as errors, and an `overrides` entry for `**/*.tsx`) and `Lint.ucf` to `packages/e2e/fixtures/apps/lint-format/`: a `debugger;` and an unused variable in each target block, and `$style.card` used in `<react>` and `<svelte>`. Real `mf-lint --format json`: exactly the expected rule codes, and for each one the `.ucf` text at the reported offset and length is the offending code (`debugger;`, the variable name). No `no-undef` for `$style`. The `overrides` rule applies to the `<react>` block only. After the run, no temp file is left. `Clean.ucf` in the same app gives no findings and exit 0.

### 7.9 Propose `.ucf` support to oxc, with a canary test

- Build: open an issue (and, if the maintainers agree, a PR) on `oxc-project/oxc` proposing a `.ucf` loader next to the `.vue` / `.svelte` / `.astro` ones in oxlint's partial loader. The issue gives the format rules (spec 2 and 3.2: raw-text root split, the first closing tag wins), what to lint per block (`<react>` whole as TSX, `<vue>` and `<svelte>` through their existing loaders at an offset) and a link to our lint fixtures. As a second option it asks for a pluggable file loader. The link goes into docs/plan.md under milestone 7.
- Deliverable: the upstream proposal, linked from the plan, and a test that tells us when it lands.
- Test: area Editor, `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`. Runs the real pinned `oxlint -f json` directly on `packages/e2e/fixtures/apps/lint-format/` and checks that it lints no `.ucf` file today. When an oxlint upgrade starts reading `.ucf` files, this test fails with a message saying to compare its findings with `mf-lint` and switch `mf-lint` to plain oxlint.

### 7.10 Language server: formatting (format on save)

- Build: a Volar service plugin `multifront-format` in `packages/language-tools/src/server/` answers `textDocument/formatting` for the root `.ucf` document with one whole-document edit from `formatUcf`. Every embedded code mapping sets `format: false`, so the CSS, TypeScript, Vue and HTML services never format a block on their own. oxfmt is loaded from the workspace folder (the project's own install); if it is missing, formatting is off and the server logs one line. `packages/vscode` adds `configurationDefaults` `"[ucf]": {"editor.defaultFormatter": "<publisher>.multifront-vscode"}`, so VS Code's `editor.formatOnSave` uses us.
- Deliverable: Format Document and format on save in VS Code give exactly what `mf-fmt` writes.
- Test: area Editor, `packages/e2e/editor/server/format.spec.ts`. Real server over LSP on a temp copy of `lint-format/`: open `Messy.ucf`, send `textDocument/formatting`, apply the edits. The text equals the real `mf-fmt` output on another copy, byte for byte. The test repeats this on `lint-format-svelte/` (Svelte block formatted) and on a copy with no oxfmt installed (no edits, no crash).

### 7.11 Language server: lint diagnostics

- Build: a Volar service plugin `multifront-lint` gives `provideDiagnostics` for the root `.ucf` document through `lintUcf`, fed the in-memory text, not the file on disk. It runs on open and on change (Volar's diagnostic debounce), and again when `.oxlintrc.json` changes (`workspace/didChangeWatchedFiles`). Findings become LSP diagnostics with `source: 'oxlint'`, `code`, and `codeDescription.href` from the oxlint `url`; severity error / warning / advice maps to 1 / 2 / 3. oxlint is loaded from the workspace folder, like oxfmt.
- Deliverable: oxlint findings show in VS Code in every target block, live, matching `mf-lint`.
- Test: area Editor, `packages/e2e/editor/server/lint.spec.ts`. Real server over LSP: open `Lint.ucf`, pull diagnostics. They match the real `mf-lint --format json` output on the same file (code, range, severity). Then a real `didChange` removes the `debugger;` from `<vue>` and that one diagnostic goes away, without saving. Then the test edits `.oxlintrc.json` on disk to turn `no-debugger` off and the remaining ones go away.

### 7.12 The three commands in CI, and from the packed package

- Build:
  - `packages/e2e/fixtures/tsconfig.fixtures.json`: includes every valid fixture component and app, leaves out `types-broken/`, `lint-format/`, `lint-format-svelte/`, `components/invalid/` and `components/fuzz/`.
  - `packages/e2e/editor/gate.spec.ts`: runs the real `mf-tsc -p packages/e2e/fixtures/tsconfig.fixtures.json` and the real `mf-lint` over the same valid fixtures with the repo's `.oxlintrc.json`. Both must exit 0; on failure the test prints the tool output. A type or lint error found in an earlier milestone's fixture is fixed in this PR (AGENTS.md: found issues are fixed). A fixture that breaks a lint rule on purpose (a splitter edge case in `TsxEdges.ucf`, say) is left out by name, with a one-line reason, instead of being changed.
  - `packages/e2e/consumer/language-tools.spec.ts`: packs `@multifront/language-tools` with M5's helper, installs it with `oxlint`, `oxfmt` and `typescript` into a fresh real project holding a copy of `types-every-target/` and `lint-format/`, and runs the installed `mf-tsc`, `mf-lint` and `mf-fmt --check` bins from `node_modules/.bin`.
- Deliverable: every PR fails when a fixture breaks one target or gets an oxlint error, and the three bins are proven to work from the published package, not only from source.
- Test: the two spec files above (areas Editor and Consumer). The gate spec also runs both commands on a temp copy of the fixtures with `ReactBreaks.ucf` added and checks exit 1, so the gate cannot pass silently.

### 7.13 Package the VS Code extension

- Build: `packages/vscode/package.json` gets the Marketplace fields `publisher`, `displayName`, `icon` and `categories` (M2 already set `engines.vscode`, `repository`, `license`, and packs the `version` from `version.json`). The bundle (M2's bundler) holds the extension entry, the server (`@multifront/language-tools/server` with Volar, `@vue/language-core`, `svelte2tsx`) and the TypeScript plugin, which ships as a folder under the extension's own `node_modules` so `contributes.typescriptServerPlugins` can find it (the way Vue's extension ships its plugin pack). TypeScript, oxlint and oxfmt are not bundled: the server uses the workspace's TypeScript (VS Code's bundled one as fallback) and the workspace's oxlint and oxfmt. So the `.vsix` has no native binary and stays one file for every platform: M2 step 2.10 gave the bundles oxc's wasm binding for `oxc-parser` (core parses `<react>` with it). M2's `pnpm devx vsix` command grows to bundle all of this; it already runs `vsce package` on a staged copy whose only dependency is the plugin pack (so the pack ships), writing `packages/vscode/multifront-vscode-<version>.vsix` (git-ignored).
- Deliverable: `pnpm devx vsix` makes an installable `.vsix` that works with no repo `node_modules` next to it.
- Test: area Editor, `packages/e2e/editor/vscode/vsix.spec.ts`.
  1. Runs the real `pnpm devx vsix`, unzips the `.vsix` into a temp folder outside the repo, and starts the server from the unzipped files over stdio. It answers completion, diagnostics and formatting on a copy of `lint-format/` (so nothing it needs was left out of the bundle).
  2. Starts a real VS Code with M2's harness (`runInVsCode()` in `editor/lib/vscode.ts`: the pinned version, its own Xvfb on a headless Linux), installs the `.vsix` into a fresh extensions folder, opens a copy of `types-every-target/` and checks with VS Code's own commands: `.ucf` files get the `ucf` language id, `vscode.languages.getDiagnostics` holds the oxlint and TypeScript findings, `vscode.executeFormatDocumentProvider` returns the `mf-fmt` result, and a `.tsx` importer's hover shows the React props (the TypeScript plugin loaded).

### 7.14 Publish to the VS Code Marketplace and Open VSX

- Build: `.github/workflows/vscode-release.yml`. On a published GitHub release whose tag matches `version.json`, it runs `pnpm devx vsix` and the 7.13 test, then publishes the same file twice: `vsce publish --packagePath <vsix>` (secret `VSCE_PAT`) and `ovsx publish <vsix>` (secret `OVSX_PAT`). The secrets are read only by those tools in the workflow, never by repo scripts, so `scripts/lib/env.mjs` gets no row. A short "Publishing the extension" section in SETUP.md lists the one-time setup (publisher, Open VSX namespace and its Eclipse agreement, both tokens). The extension's README stays thin (packages/AGENTS.md).
- Deliverable: a release publishes the extension to both stores from one tested file.
- Test: area Editor, the 7.13 `vsix.spec.ts` runs inside the workflow before any publish, so a broken `.vsix` never ships. The workflow's first real run (the first release after this step) is checked by hand: the extension installs from each store into a clean VS Code and a clean VSCodium, and the 7.13 checks pass there.

## Hands to later milestones

M7 is the last planned milestone. These are what it leaves for every release after v1, and for any new block kind (a Solid target, a `<types>` block):

- Bins of `@multifront/language-tools`: `mf-tsc`, `mf-lint`, `mf-fmt`. Used by library authors in their own CI.
- Functions exported from `@multifront/language-tools`: `formatUcf(fileName, source, config)`, `lintUcf(files, {root})`. Used by the server, and by any other editor setup (WebStorm, Neovim) that loads the server from npm.
- `blockFile(block)` in `packages/language-tools/src/blocks/blockFile.ts`. A new block kind must give its file ending here; the registry loop of 7.6 fails otherwise.
- The language plugin's `getExtraServiceScripts` returning every target's virtual script. A new target row is checked by `mf-tsc` once its `types()` script exists.
- `packages/e2e/editor/gate.spec.ts` and `packages/e2e/fixtures/tsconfig.fixtures.json`. Every fixture added later must type-check in every target and be oxlint clean.
- `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`. Tells us when upstream `.ucf` support lands.
- `pnpm devx vsix`, `packages/vscode/multifront-vscode-<version>.vsix` and `.github/workflows/vscode-release.yml`. Used by every release.
- Fixtures: `packages/e2e/fixtures/apps/types-every-target/`, `types-broken/`, `lint-format/`, `lint-format-svelte/`, `svelte-markup/`.

## Exit test

`packages/e2e/editor/vscode/exit.spec.ts` (area Editor), on a copy of `fixtures/components/Card.ucf` (all three targets) inside a small project with `.oxlintrc.json`, `.oxfmtrc.json` and a tsconfig:

1. Real `mf-tsc`, `mf-lint` and `mf-fmt --check` all exit 0.
2. The test edits only the `<svelte>` block to pass a number to a `string` prop and adds `debugger;` to the `<vue>` script. Real `mf-tsc` now fails with one error inside the `<svelte>` block; real `mf-lint` reports `no-debugger` at the `<vue>` line.
3. A real VS Code with the packed `.vsix` installed opens the same file and shows the same two findings at the same ranges.
4. Format Document in that VS Code gives byte for byte what `mf-fmt` writes on a second copy.
5. In that VS Code, completion after `<input bi` in the `<svelte>` markup lists `bind:value`, and after `<Icon ` (the test adds the `Icon.ucf` of 7.5 next to the copy and imports it) lists `name` and `size`.

All of it with real tools: no mock server, no fake oxlint output, no stubbed VS Code.

## Risks and open questions

Risks:

- **Volar has no extra service scripts on the `tsc` path either.** `@volar/typescript` 2.4.28 `proxyCreateProgram` warns `getExtraServiceScripts() is not available in this use case.`, as its tsserver plugin does (spike 1, answer 3). 7.2 must use whatever M4 builds to serve per-target scripts, unless a newer Volar adds them.
- **oxfmt and oxlint are young.** oxfmt is 0.x and oxlint's JSON shape is not a promised contract. Both are exact-pinned in the repo, and the parity tests (7.6, 7.8, 7.11) fail on any change in a bump. Users bring their own versions through the peer ranges.
- **Svelte formatting depends on install layout.** oxfmt loads `svelte/compiler` from its own location. With pnpm's strict layout this works only when `svelte` is installed so pnpm links it as oxfmt's peer. 7.7 warns and skips instead of failing.
- **Linting a block alone.** Block files sit in a temp folder, so rules that follow imports (`import/no-cycle`) do not see across files, and type-aware linting (`--type-aware`, tsgolint) is not supported. Upstream support (7.9) would fix both.
- **`runTsc` patches TypeScript's JS.** Same approach as `vue-tsc`, through `@volar/typescript`. The native TypeScript port (TypeScript 7) has no such JS to patch. `vue-tsc` faces the same problem; we follow Volar's answer when it comes.
- **`svelte2tsx` output shape.** Prop completions (7.5) map into the props object `svelte2tsx` generates. Its shape can change between versions; it is pinned, and the 7.5 test catches a change.
- **Packaging.** `vsce` and pnpm workspaces clash on dependencies, hence `--no-dependencies` and a full bundle. The TypeScript plugin folder under the extension's `node_modules` must survive packing; the 7.13 test checks the unzipped file. Real VS Code tests need a display (M2's harness starts Xvfb) and a pinned VS Code download, cached in CI.
- **Store accounts.** Marketplace tokens expire (Azure DevOps PATs); Open VSX needs the namespace claimed and the Eclipse publisher agreement signed. A maintainer does this once by hand.
- **Other extensions.** Vue's and Svelte's extensions do not claim `.ucf`, and the default formatter is set only for `[ucf]`. The oxc VS Code extension ignores `.ucf` today; if upstream support lands it would lint `.ucf` too and show findings twice.

Open questions:

1. **Spec 6.1 is out of date on Svelte.** oxfmt 0.67.0 can format `.svelte` with its `svelte` option. This plan keeps blocks as written by default and formats them only when the project turns the option on (7.7). Confirm, and 7.7 updates spec 6.1.
2. **Block indentation.** `mf-fmt` writes block text flush left, like Vue's default for `<script>` and `<style>`. The spec's examples indent block text by two spaces. Re-indenting after oxfmt would change multi-line template literals, so this plan does not. Is flush left acceptable?
3. **`.svelte` importers on the command line.** `mf-tsc` checks `.ts`, `.tsx`, `.vue` and every `.ucf` target, but not `.svelte` files that import `.ucf` (svelte-check does not run our TypeScript plugin). Add `.svelte` files to `mf-tsc` through `svelte2tsx`, or leave it?
4. **Settled:** M4's `types()` returns the script `@vue/language-core` generates and M6's the `svelte2tsx` output, both with the template and markup check code.
5. **Publisher id and pre-release.** Which Marketplace publisher and Open VSX namespace? Publish 0.x versions on the pre-release channel (`--pre-release`)? The stores do not accept semver pre-release tags like `0.1.0-beta.1`, which matters for the one-version rule.
6. **Settled:** lint and format read the block's own text; architecture.md already says so.

## Out of scope

- `mf-lint --fix` and lint code actions in the editor.
- Range formatting and format on type.
- Formatting `<style lang="stylus">` or any language oxfmt does not format (stays as written).
- `mf-tsc` emitting files. Declarations come from the library build (M5).
- oxlint and oxfmt configs written in JS or TS (`oxfmt.config.ts`). Only JSON / JSONC configs are read.
- Type-aware lint rules.
- Packaging for other editors (WebStorm, Neovim). They can load the server and the TypeScript plugin from the npm package.
- Proposing `.ucf` support to oxfmt upstream (the 7.9 issue mentions it as a follow-up only).
- Running `mf-fmt` over this repo's own files.
