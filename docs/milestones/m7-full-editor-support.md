# Milestone 7: Full editor support

## Goal

A `.ucf` file gets the same checks as any other source file, on the command line and in VS Code:

- `mf-tsc` type-checks every target of every `.ucf` file, so a block that breaks one framework fails CI.
- The `<svelte>` block gets markup completions: HTML tags, Svelte elements, directives, `{#if}` style blocks and component props.
- `mf-fmt` formats each block with oxfmt's `format()` and puts the file back together.
- `mf-lint` lints each block with oxlint and maps every finding back to the right line of the `.ucf` file.
- The language server runs the same formatter and linter, so VS Code shows what the command line shows (format on save, diagnostics).
- The VS Code extension is packaged with `language-tools` bundled and published to the VS Code Marketplace and Open VSX.
- Every command follows the command rules (spec 8.1): it checks one file, a folder or the whole project, prints `Finding`s readably or with `--format json`, and exits 0 / 1 / 2. A coding agent runs it on what it just changed and acts on the result.

Spec: sections 5, 6, 6.1 and 8.1. Plan: milestone 7.

### Decision: the commands in this repo's CI

- **`mf-tsc`: yes.** Every valid fixture must type-check in every target it has. A fixture that fails one framework is a bug in the fixture or in our tools, and CI should say so.
- **`mf-lint`: yes.** Every valid fixture must have zero oxlint errors under the repo's own `.oxlintrc.json`. Warnings are allowed.
- **`mf-fmt`: no, not over the repo.** AGENTS.md says `pnpm devx format` is the only formatter run and its scope never widens. Fixtures also hold deliberately odd code (splitter edge cases like `a < b` and `</react>` in a string) that a formatter would erase. `mf-fmt` runs in CI only inside its own tests, on copies of its own fixtures.
- **How:** both run as an e2e test in `packages/e2e/editor/` (step 7.12), so `pnpm devx test`, and therefore `pnpm devx check` and CI, runs them. No new devx command.

### Decision: lint and format read the block's own text

architecture.md says oxlint and oxfmt run on the `build` file. The build file of `<react>` carries the scope stamp and the injected `$style` import. Formatting that and writing it back would put generated code into the user's file. Linting it gives findings on code the user never wrote. So `mf-fmt` and `mf-lint` read the **block's own text** and give it the **file ending of its build file** (`.tsx`, `.vue`, `.svelte`), or the `lang` ending for a `<style>` block (`.css`, `.scss`, `.less`). Step 7.6 updates the one line in architecture.md.

### Decision: every command follows the command rules

Decided in M6.1 (6.1.6). `mf-tsc`, `mf-lint` and `mf-fmt` run through `runCommand` and print `Finding`s (spec 8.1), as `mf-build` does. Positions are always in the file the user wrote, the `.ucf` file, never a block file or a virtual script.

Shared by the three:

- **Paths:** each takes files or folders after the options; none means the whole project (`mf-tsc`) or every `.ucf` file under the current folder (`mf-fmt`, `mf-lint`). Paths are merged into one file set, so a file named twice or inside a named folder is checked once. A folder means its files below it, `node_modules` and dot folders left out. Exit 2, one stderr line, for:
  - a path that does not exist (`runCommand` checks this before `run`);
  - a path with no file to check (`mf-tsc: pages holds no file of tsconfig.json`, `mf-lint: empty holds no .ucf file`), also once `mf-tsc --framework` left none (`mf-tsc: ui holds no file of tsconfig.json to check in svelte`, `mf-tsc: tsconfig.json holds no file to check in svelte` with no path), so a run never passes over zero files;
  - in `mf-fmt` and `mf-lint`, a file that is not `.ucf` (`mf-lint: src/main.ts is not a .ucf file; lint it with oxlint`) or a named file the config's `ignorePatterns` excludes (`mf-lint: src/Old.ucf is ignored by .oxlintrc.json`). Files under a named folder that `ignorePatterns` excludes are skipped silently.
- **Config:** each finds the config nearest above each file (`tsconfig.json`, `.oxfmtrc.json`, `.oxlintrc.json`), as Vue's language tools and tsserver find the nearest tsconfig per file. Files are grouped by their config: one program (`mf-tsc`), one oxlint run (`mf-lint`) or one resolved config (`mf-fmt`) per group. No `.oxfmtrc.json` / `.oxlintrc.json` found: the tool's defaults (the lint wrapper has no `extends`).
- **`ucfFiles(paths, ignored, otherFiles)`** in `packages/language-tools/src/files.ts` (7.6) turns paths into `.ucf` files by these rules, with the exit 2 errors above (`ignored(file)` names the config that ignores a file, `otherFiles` is the hint for a file that is not `.ucf`: `format it with oxfmt`); `mf-lint` (7.8) reuses it.
- **A missing tool is exit 2:** `typescript`, `oxlint` or `oxfmt` that cannot be loaded from the project gives one line (`svelte` too, once `mf-tsc` checks a `<svelte>` block), `mf-lint: oxlint is not installed in <root>; add it to devDependencies`. So does oxlint exiting with anything but 0 or 1, or printing a stdout that is not its JSON report (oxlint also exits 1 on a bad config): its first stderr line.
- **A `.ucf` file whose blocks do not split** gives core's `splitBlocks` codes through `findingOf`, never a silent skip.
- **`runCommand` grows here**, each part with the step that first needs it:
  - 7.1: `CommandSpec.paths`, the help text of the paths argument, printed as the last summary line of the help. When it is set, positionals are allowed, each is checked to exist (exit 2), and they are passed as `run(values, paths)`; the usage line reads `Usage: <name> [options] [paths...]`. Without it `mf-build` keeps "takes options only".
  - 7.1: `CommandOption` picks `short` too from node's `ParseArgsOptionDescriptor` (`'type' | 'multiple' | 'short'`); the help prints `-p, --project <file>`. `help` gets `short: 'h'` in `SHARED_OPTIONS`, and the two branches in `command.ts` that name `help` for its `-h` go.
  - 7.8: `CommandResult.warningsFail`: exit 1 on warnings too. The help's fixed exit code line stays; the option that sets it says so (`--deny-warnings`: "exit 1 on warnings too"), and spec 8.1 lists the case.
- **New codes** in core's `DiagnosticCode`: `unformatted` and `format-error` (7.6), `missing-svelte` (7.7). `mf-tsc` reports TypeScript's (`TS2322`), `mf-lint` oxlint's (`eslint(no-debugger)`).

**`mf-tsc`: how it checks one file.** `tsc` cannot check one file with the project's settings: `tsc a.ts` drops the tsconfig, and `tsc -p tsconfig.json a.ts` fails with TS5042. Checking only the given files (them as the program's root names) loses the tsconfig's other files (`env.d.ts`, globals) and gives false errors; checking everything and reporting only the given files is no faster. So `mf-tsc` loads the tsconfig and builds the whole program, as `tsc` does, then asks TypeScript for the diagnostics of the given files only (syntactic and semantic per file, plus the program's global and options diagnostics), as tsserver does for one open file. On `packages/vite` (493 program files, measured in 6.1.6): creating the program takes about 1.0 s, checking every file 1.6 to 1.8 s, checking one file 0.4 to 0.6 s.

- **No `runTsc`.** The `tsc` CLI cannot print `Finding`s. `mf-tsc` builds its program itself with `proxyCreateProgram(ts, ts.createProgram, ...)` from `@volar/typescript` (the proxy `runTsc` puts into `tsc`), our language plugin and `resolveUcfImport`. It takes no `tsc` flags and never emits; the tsconfig's emit options are ignored.
- **Which tsconfig:** `-p, --project <file>`; else the nearest `tsconfig.json` above each file (`ts.findConfigFile`), with its `references` followed as tsserver does: a file goes to the first project, the nearest one then its references depth first, whose program holds it. So a create-vite or create-vue root (`"files": []` plus `references`) and this repo's root tsconfig work. A folder looks the same way from the folder, and also takes every `tsconfig.json` below it (outside `node_modules`); each file under the folder goes to the nearest project holding it. With no path: the tsconfig above the current folder, and every project it references. A file with no tsconfig, or one no project holds, is exit 2: `mf-tsc: src/Foo.ucf is not part of tsconfig.json; add it to "include" or pass -p`. With `-p`, only that project and its references.
- **Config errors are exit 2:** reading the tsconfig fails (missing file, bad JSON, unknown compiler option, TS18003 no inputs) → one stderr line, `mf-tsc: tsconfig.json:3:5: error TS5023: Unknown compiler option 'foo'.`, plus ` (and N more)`. The program's global and options diagnostics (TS2688 for `types: ["nonexistent"]`) are findings with no file, exit 1, as in `mf-build`.
- **One framework of one file:** `--framework <name>` (repeatable, as in `mf-build`) limits the `.ucf` checks to those frameworks' scripts: the file's own script for `react` (`MAIN_SCRIPT_TARGET`), `targetScriptName(file, target)` for the others. Files that are not `.ucf` are checked as usual; a `.ucf` file under a folder that has none of those blocks is skipped. A named `.ucf` file with none of them is exit 2: `mf-tsc: ReactBreaks.ucf has no <svelte> block`. Any other value is exit 2: `unknown framework 'angular'; use vue, react or svelte`.
- **Output:** `types-broken/ReactBreaks.ucf:4:17: error TS2322 (react): Type 'number' is not assignable to type 'string'.`, then `mf-tsc: checked 3 files with tsconfig.json: 1 error` (`..., no errors` when clean; `checked 5 files with 2 tsconfigs: ...` when there are several). JSON data: `projects: [{tsconfig, files}]`, paths relative to the cwd. A `.ucf` finding carries `block` and `framework` (the script's target); a `.ts`, `.tsx` or `.vue` file carries neither. The message is TypeScript's chain flattened, levels joined with a space. Error and Warning categories map to `error` and `warning`; suggestions are not reported, as in `tsc`.

**`mf-fmt`:** write mode prints `mf-fmt: formatted 2 of 5 files`. `--check` writes nothing and gives one `unformatted` error per file, at the first character that differs, its `block` set, message `not formatted; run mf-fmt <path>`, then `mf-fmt: 2 of 5 files not formatted`. JSON data: `{files, changed}` (written, or would change). oxfmt errors for a block give `format-error` at their `.ucf` position, and that file stays unchanged. `formatUcf(fileName, source, config)` returns `{text, findings, missingSvelte}`: the formatted text (the source as is when there are findings), the `format-error` findings, and whether a `<svelte>` block the config formats stayed as written because oxfmt cannot load `svelte/compiler`; the server (7.10) uses the same.

**`mf-lint`:** a finding is oxlint's `code`, `message`, severity (`advice` becomes `warning`) and position, with `block` and `framework` set to the block's tag. oxlint's `help` and `url` stay out of the CLI output (spec 8.1, one finding shape); `lintUcf` keeps them for the server (7.11). Summary `mf-lint: linted 5 files: 2 errors, 1 warning` (`..., no problems` when clean). JSON data: `{files}`. `--deny-warnings` sets `warningsFail`.

**Help texts.** Each command's test pins its help exactly. The line starting `Paths are` is `CommandSpec.paths`; the line above it is `summary`. `mf-tsc` once 7.3 is in. 7.1 ships without the `--framework` line, with the summary `Type-checks the <react> block of .ucf files, with the .ts and .tsx files that import them.` and the example `mf-tsc src/Card.ucf --format json` (both true before `--framework` exists); 7.2 moves to the summary below with `.ts and .tsx` in place of `.ts, .tsx and .vue`, and to the example below; 7.3 names `.vue`:

```
Usage: mf-tsc [options] [paths...]

Type-checks .ucf files in every framework, with the .ts, .tsx and .vue files that import them.
Paths are files or folders of the project; none checks the whole project.

Options:
  -p, --project <file>   the tsconfig.json to use (default: the nearest one above each path)
  --framework <name>     check .ucf files only in this framework: vue, react or svelte; repeat for more
  --format <format>      text or json (default: text)
  -h, --help             show this help

Example:
  mf-tsc src/Card.ucf --framework svelte --format json

Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
```

`mf-fmt` and `mf-lint` follow the same layout:

- `mf-fmt`: summary `Formats each block of .ucf files with oxfmt and the project's .oxfmtrc.json.`, paths `Paths are .ucf files or folders; none formats every .ucf file under the current folder.`; option `--check` "write nothing; list the files that are not formatted"; example `mf-fmt --check src/Card.ucf`.
- `mf-lint`: summary `Lints each block of .ucf files with oxlint and the project's .oxlintrc.json.`, paths `Paths are .ucf files or folders; none lints every .ucf file under the current folder.`; option `--deny-warnings` "exit 1 on warnings too"; example `mf-lint src/Card.ucf --format json`.

**Speed.** 7.12's gate spec times the real `mf-tsc` on `Card.ucf`, on one fixture folder and on the whole `tsconfig.fixtures.json`, and `mf-lint` on one file and on every fixture: median of 5 fresh runs each, printed in the test log, no time assertion. 7.12 writes the CI numbers into this document. No reuse between runs: TypeScript's build info keeps the diagnostics of unchanged files and still parses every file, so it cannot speed up a check of the one file an agent just changed.

## Needs from earlier milestones

From M1 (splitter, block kinds, styles, e2e package):

- `splitBlocks(source, filename)` from `@multifront/core`, returning blocks with `{ type, attrs, content, start, end, contentStart, contentEnd }` and errors with `{code, message, line, column}`.
- `BlockKind`, `BLOCK_KINDS` and `getBlockKind(tag)` from `packages/core/src/blocks/index.ts` (order `style, vue, react, svelte`), and `VirtualFile['ext']`.
- The private `packages/e2e` package (Vitest project `e2e`) with `packages/e2e/editor/`, `packages/e2e/consumer/`, `fixtures/components/` and `fixtures/apps/`.
- The fixture helpers in `packages/e2e/fixtures/index.ts`: `FIXTURES_DIR`, `componentPath()`, `listComponents()`, `copyApp(name)` (a fresh copy under `packages/e2e/.tmp/`). Every "temp copy" below is a `copyApp()` copy.
- The invalid fixtures in `fixtures/components/invalid/` and the saved fuzz cases in `fixtures/components/react/fuzz-found/`, which the CI gate of 7.12 leaves out.

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

From M5 (Svelte target):

- `Card.ucf.svelte.ts` through `svelte2tsx`, from `types(block, ctx)`, with the markup expressions in it (what `svelte2tsx` generates) and a mapping back to the `<svelte>` block.
- `packages/language-tools/src/blocks/svelte.ts` `editor(block, ctx)`, returning the `svelte2tsx` TypeScript code as embedded code.
- The Svelte fixture app, and `svelte` installed in `packages/e2e` (oxfmt needs `svelte/compiler` to format Svelte, step 7.7).
- `fixtures/components/Card.ucf` with all three target blocks and its `<style module>` (M1 made it; M4 and M5 fill its `<vue>` and `<svelte>` blocks). The exit test uses it.

From M6 (library build):

- The pack-and-install helper of `packages/e2e/consumer/` (packs a workspace package into a tarball and installs it into a fresh real project). Step 7.12 reuses it for `@multifront/language-tools`.

From M6.1 (fixes and groundwork):

- The command rules of spec 8.1: `findingOf(diagnostic, split)` and `runCommand(spec, args, run)` in `packages/core/src/command.ts`, their types in `packages/core/src/types.ts` (`Finding`: `file?`, `line?`, `column?`, `end?`, `code`, `severity`, `message`, `block?`, `framework?`, 1-based; `CommandSpec`, `CommandOption`, `CommandResult`, `CommandValues`), all exported from `@multifront/core`. `runCommand` adds `--format text|json` and `-h, --help`, prints the findings and a summary line or one JSON document, and returns 0 / 1 / 2.
- `mf-build` on it (`packages/vite/src/library/cli.ts`) and its test `packages/e2e/build/library-cli.spec.ts`: the model for each command and its test.
- Svelte roots that take `class` and `style`, with their types in the Svelte virtual script (7.5 and `mf-tsc` see them).

Outside the milestones (new pinned packages, devDependencies unless said otherwise, added in the step that needs them, subject to the 30-day release age rule):

- `@vscode/vsce`, `ovsx`, `@vscode/test-electron`.
- `ignore` and `minimatch` (7.6) are new pinned dependencies of `@multifront/language-tools`: `ignorePatterns` are gitignore lines, and `overrides` and `.editorconfig` sections are globs that match dot folders, as oxfmt matches them.
- `volar-service-html` (7.4) is a new pinned dependency of `@multifront/language-tools`, beside `volar-service-css`: the published server runs it. `vscode-html-languageservice` (7.4) is a root devDependency, types only (the Svelte data provider's), at the version `volar-service-html` resolves. `@volar/typescript` already is one; `mf-tsc` uses its `proxyCreateProgram`.
- `oxfmt` and `oxlint` as optional `peerDependencies` of `@multifront/language-tools` (ranges), so a project's own versions are used.
- A VS Code Marketplace publisher and an Open VSX namespace with the same id, and the repository secrets `VSCE_PAT` and `OVSX_PAT` (step 7.14). A maintainer creates these once by hand.

## Steps

### 7.1 `mf-tsc` for the React target and its importers

- Build: `packages/language-tools/src/tsc/index.ts` and the bin `mf-tsc` (`packages/language-tools/bin/mf-tsc.js`, listed under `bin` in its `package.json`), on `runCommand` as "Decision: every command follows the command rules" says. It builds the program with `proxyCreateProgram(ts, ts.createProgram, ...)` from `@volar/typescript`, our Volar language plugin (`.ucf` as an extra extension), and `resolveUcfImport` so imports follow spec 4.2 (attribute, then importer, then the default target from the tsconfig plugin entry). It never emits and takes no `tsc` flags. Paths, `-p, --project`, the tsconfig lookup (`references` followed) and its exit 2 cases as decided above. A private `tscFinding(ts, diagnostic, split?)` in `tsc/index.ts` turns a TypeScript diagnostic, as Volar maps it back to the `.ucf` text, into a `Finding` (`split`: the `.ucf` file's, for its `block`; `framework` is the checked script's target). A `.ucf` import the target rules reject gives our code (`missing-target-block`), not `TS2307`: `withImportErrors()` in `packages/language-tools/src/importErrors.ts`, shared with the TypeScript plugin, as is the `.ucf` resolver wrapper, `withUcfResolution()` in `resolve.ts`. The folder walker, `filesUnder()`, and the project's TypeScript loader, `projectTypeScript()`, move to `packages/language-tools/src/files.ts`. `runCommand` gains `CommandSpec.paths` and `short`.
- Deliverable: `mf-tsc [paths]` type-checks `.ts` / `.tsx` files that import `.ucf` files, and the `<react>` block of every `.ucf` file: the whole project, one file or one folder, readable or `--format json`, exit 0 / 1 / 2. Findings carry `.ucf` lines and columns.
- Test: area Editor, `packages/e2e/editor/tsc/react.spec.ts`. New fixture app `packages/e2e/fixtures/apps/types-every-target/` (valid) and `packages/e2e/fixtures/apps/types-broken/` with `ReactBreaks.ucf` (only a `<react>` block, which passes a number to a `string` prop) and `pages/main.tsx` passing a wrong prop to a valid `.ucf`. The test spawns the real `mf-tsc`:
  1. Whole project, from a temp copy of each app: exit 0 and the summary line only on the valid app; on the broken one, exit 1 and the exact readable lines and summary.
  2. `--format json` on the broken app: the exact document. Each finding's line and column to `end` is the bad expression in the fixture text.
  3. One file: `mf-tsc ReactBreaks.ucf` reports only its finding. One folder: `mf-tsc pages` reports only `main.tsx`'s; a `pages/node_modules/` file with a type error in the copy is not reported. `mf-tsc ReactBreaks.ucf ReactBreaks.ucf` reports its finding once.
  4. The same file from the repo root, with the tsconfig found above it, and again with `-p`. Both apps' files in one run: two `projects` entries, findings from each, the `with 2 tsconfigs` summary.
  5. References: a temp copy whose root `tsconfig.json` has `"files": []` and `references` to `tsconfig.app.json` (the create-vite shape). `mf-tsc` with no path and `mf-tsc ReactBreaks.ucf` both report the error from the referenced project.
  6. A temp copy whose tsconfig sets `types: ["nonexistent"]`: a TS2688 finding with no file, exit 1.
  7. A temp copy with `components/invalid/DuplicateReact.ucf` added: its `duplicate-target` findings.
  8. Exit 2, stdout empty, one stderr line: an unknown option (names the real ones), `--format xml`, a missing path, a file the tsconfig does not hold, a file with no tsconfig above it (in `os.tmpdir()`), a folder holding no program file, `-p` to a missing file, a tsconfig with an unknown compiler option, one with two (the line ends ` (and 1 more)`), and an app copy in `os.tmpdir()` with its tsconfig but no typescript to load.
  9. `--help` and `-h`: exit 0, the exact help.
  10. A `.ts` importer picking `with { framework: 'vue' }` from `ReactBreaks.ucf`: one `missing-target-block` finding at the specifier, no `TS2307`.
- Status: done

### 7.2 `mf-tsc` checks every target of every `.ucf` file

- Build: `proxyCreateProgram` serves no extra service scripts (the first risk), so `mf-tsc` uses what M4 built for tsserver: every served target's script of a `.ucf` file (`Card.ucf.vue.ts`, `Card.ucf.svelte.ts`) is a root of its program, beside the `.ucf` file's own `<react>` script, also for a `.ucf` file the program only reached through an import. `programTargetScripts(ts, main)` in `packages/language-tools/src/targetScripts.ts` gives their names, sources and the target languages that map them into the `.ucf` file, as tsserver's do; the program lives in `packages/language-tools/src/tsc/program.ts`. In `mf-tsc`, a diagnostic in a generated part with no mapping is reported on the block's opening tag, never dropped; only a generator's unused helper (`reportsUnnecessary`, under `noUnusedLocals`) is left out, and one a tool hides through its mapping flags stays hidden. A `<svelte>` block with no `svelte` to load is exit 2; markup Svelte cannot parse gives the build's `svelte-parse-error` (core's `svelteParseError`). `mf-tsc` gains `--framework <name>` (repeatable): the `.ucf` checks cover only those frameworks' scripts.
- Deliverable: one `mf-tsc` run fails when any one target of any file is broken, even when nothing imports that target. `mf-tsc <file> --framework <name>` checks one framework of one file.
- Test: area Editor, `packages/e2e/editor/tsc/every-target.spec.ts`, its shared helpers and the broken app's findings in `packages/e2e/editor/lib/tsc.ts`. Adds to `types-broken/` (its `include` gains `*.ts`): `VueBreaks.ucf` (valid `<react>` and `<svelte>`, a template type error in `<vue>`), `SvelteBreaks.ucf` (same, error in `<svelte>` markup), `OnlyReactExport.ucf` plus `main.ts` importing its named export `with { framework: 'vue' }` (spec 11, "Different exports per target"). Real `mf-tsc`: each error lands inside the right block, on the right line. The valid `types-every-target/` app (all three targets) still exits 0. The same broken files opened in the real tsserver with our plugin (M2 harness, hybrid mode) give the same codes at the same positions. One framework: `mf-tsc SvelteBreaks.ucf --framework svelte --format json` gives only the Svelte finding, with `block` and `framework` set to `svelte`; `--framework react` on the same file exits 0; `mf-tsc pages --framework svelte` still reports `main.tsx`'s finding; `mf-tsc ReactBreaks.ucf --framework svelte` exits 2 (`has no <svelte> block`); `--framework angular` exits 2 with one stderr line.
- Status: done

### 7.3 `mf-tsc` also checks `.vue` importers

- Build: `mf-tsc` adds `@vue/language-core`'s language plugin for `.vue` files (already a dependency since M4), so a `Page.vue` that imports `./Card.ucf` is checked in the same program. One command replaces `vue-tsc` in a project that uses `.ucf` files. The help's first summary line names `.vue` files.
- Deliverable: `mf-tsc` type-checks `.vue` files, and their `.ucf` imports resolve to the Vue target.
- Test: area Editor, `packages/e2e/editor/tsc/vue-importer.spec.ts`. Adds `Page.vue` to `types-every-target/` (valid) and `BadPage.vue` to `types-broken/` (passes a wrong prop to a `.ucf` component in its template). Real `mf-tsc`: the valid app exits 0; the broken one reports the error in `BadPage.vue` at the prop. `mf-tsc BadPage.vue` reports only that finding. The help test of 7.1 now pins the final help.
- Status: done

### 7.4 Svelte markup completions: tags, Svelte elements, directives, blocks

- Build: in `packages/language-tools/src/blocks/svelte.ts`, `editor(block, ctx)` adds the `svelte_markup` embedded code, also without a Svelte compiler (the server loads none): the block text with `<script>` contents and every `{...}` expression replaced by spaces, so offsets stay 1:1, read lexically by `scanMarkup()` in `packages/language-tools/src/svelteMarkup.ts`. An attribute value `name={...}` becomes `"..."` with spaces inside: with plain spaces the HTML scanner reads the next attribute as its value. Its language id is `svelte-markup`, not `html`, so Vue's template services and ours never serve each other's codes. Its mapping turns on completion only (no HTML diagnostics, no HTML formatting) and leaves `{...}` unmapped, so expressions get only TypeScript's completions. The server adds `volar-service-html` with a Svelte data table (`packages/language-tools/src/svelteHtmlData.ts`): the `svelte:*` elements (`svelte:window`, `svelte:document`, `svelte:body`, `svelte:head`, `svelte:element`, `svelte:boundary`, `svelte:options`), the directive prefixes (`bind:`, `class:`, `style:`, `use:`, `transition:`, `in:`, `out:`, `animate:`) and Svelte's `bind:` list per element (`bind:value` on `input`, `textarea`, `select`, ...). Its items are rewritten or dropped so each one is valid Svelte where it lands (`packages/language-tools/src/svelteMarkupService.ts`): the meta elements only at the top level and once each, no top-level `style`, no second top-level instance `script`, `svelte:element this={$1}`, a directive or `on*` attribute takes `={$1}`, a prefix `bind:${1:name}`. A small service plugin (`multifront-svelte-markup`) completes the template blocks after `{#`, `{@` and `{:` (`{#if}`, `{#each}`, `{#await}`, `{#key}`, `{#snippet}`, `{@render}`, `{@html}`, `{@const}`, `{@debug}`, `{:else}`, `{:then}`, `{:catch}`), each only where Svelte takes it: `{@const}` as the direct child of a block branch, a component or `<svelte:boundary>`; a `{:…}` clause inside its block, never a second one.
- Deliverable: typing in the `<svelte>` markup completes HTML tags and attributes, Svelte elements, directives and blocks. Expressions inside `{...}` keep their TypeScript completions from M5's `svelte2tsx` code.
- Test: area Editor, `packages/e2e/editor/server/svelte-markup.spec.ts`. New fixture `packages/e2e/fixtures/apps/svelte-markup/Toolbar.ucf`. Through the real server over LSP the test types real edits (`didChange`) and asks for completions: `<sv` lists `svelte:window` (not inside an element), `<input bi` lists `bind:value`, `{#` lists `if` and `each`, `{@const}` and the `{:…}` clauses come only where they fit, `{ti}` inside markup lists the `title` prop (that one comes from tsserver with our plugin, hybrid mode; the rest from our server). The edits hold what VS Code holds: it auto-closes `{` in `.ucf` files, so typing `{ti` gives `{ti}`, and `{#` is tested as typed and as `{#}`. Each suggested item is then inserted into a copy of the block (tab stops filled, ` />` after a tag name) and parsed with the real `svelte/compiler` `parse`, which must not throw, so we never suggest invalid Svelte. `virtualCode.spec.ts` pins the markup code of every `<svelte>` fixture in file snapshots.
- Status: done

### 7.5 Svelte component props in markup

- Build: in `packages/language-tools/src/blocks/svelte.ts`, `propsMappings()` maps the whitespace of each component start tag (`<Icon |>`, between its name, its attributes and its end, also while the tag is still being typed) to the start of the props object `svelte2tsx` generates for that component (`props: {`), completion only. A gap's first character is left out, so right after the name stays a tag-name position. `scanMarkup()` gives the start tags and their gaps (`MarkupScan.tags`, `MarkupTag`). Props of a child imported from another `.ucf` file come from that file's Svelte virtual script (spec 4.1). tsserver with our plugin answers there (hybrid mode); our server's HTML service keeps only `bind:` and `bind:this` in a component start tag (Svelte rejects `class:`, `use:` and the like on a component, and its other attributes are props).
- Deliverable: `<Icon ` in the markup completes `Icon`'s props, with their types in the details.
- Test: area Editor, `packages/e2e/editor/server/svelte-props.spec.ts`, with 7.4's completion helpers moved to `packages/e2e/editor/lib/markup.ts`. Adds `Icon.ucf` (Svelte props `name: string`, `size?: number`) to `svelte-markup/`, imported and used by `Toolbar.ucf`. The props list and the error come from tsserver with our plugin (hybrid mode). Real edits typing `<Icon ` (unclosed, as VS Code holds it), `<Icon | />` and a multi-line tag: the list is exactly `name`, `class`, `size`, `style` (the root's `class` and `style`, spec 3.5.1) with their types in the details; `<Icon name="x" | />` leaves `name` out; `<ui.Icon | />` and `<Icon |` as the last markup give the same list, a space inside a value or before `=` none; each item, applied as VS Code applies it, parses with the real `svelte/compiler`. `<Icon|` lists names in scope, not the props, and `<input | />` nothing. Then the test types `<Icon nme="x"/>` and tsserver reports one TS2353 on `nme` (the error path through the same mapping). Our server lists only `bind:` and `bind:this` in `<Icon | />`, each one parses, text after a component keeps its items (`&amp;`), and `<input bi| />` keeps 7.4's list.
- Status: done

### 7.6 `mf-fmt`: oxfmt's `format()` block by block

- Build: `packages/language-tools/src/format/index.ts` exports `formatUcf(fileName, source, config)`, returning `{text, findings}`, and the bin `mf-fmt [--check] [paths…]`. Steps per file: `splitBlocks`, then for each block call oxfmt's `format(blockFileName, block.content, config)`, then replace only the text between `contentStart` and `contentEnd`. Text outside the blocks stays byte for byte. `blockFile(fileName, block)` in `packages/language-tools/src/blocks/blockFile.ts` names the block file `Card.ucf.<tag><ext>`: the ending of the kind's build file (`.tsx`, `.vue`, `.svelte`), or the `<style lang>` ending (`.css`, `.scss`, `.less`). Only endings oxfmt formats are sent (`.tsx`, `.vue`, `.css`, `.scss`, `.less`); any other block stays as written. Block text is written flush left, one newline after the opening tag and one before the closing tag. Config is the project's own, read as the oxfmt CLI reads it (`findFormatConfig(fileName, root)`, also used by the server in 7.10): the nearest `.oxfmtrc.json` / `.oxfmtrc.jsonc` above the file, a nested one inheriting nothing, `overrides` matched against the block file path, `ignorePatterns` against the real `.ucf` path, and the `.editorconfig` nearest above the cwd (the server's workspace folder in 7.10), its sections matched as oxfmt matches them, filling the options still unset. A config that is not JSON, not an object, or holds a value oxfmt rejects is exit 2. A block that fails to parse leaves the whole file unchanged and gives a `format-error` finding at its `.ucf` position. The bin runs on `runCommand` as "Decision: every command follows the command rules" says: paths through the new `ucfFiles(paths, ignored, otherFiles)` (`packages/language-tools/src/files.ts`), files grouped by their nearest config, `--check` findings (`unformatted`), summary, JSON data, help. The codes `unformatted` and `format-error` join core's `DiagnosticCode`. oxfmt is loaded from the project; if it cannot be, exit 2.
- Deliverable: `mf-fmt` formats `.ucf` files in place, one file, a folder or every `.ucf` file under the current folder; `mf-fmt --check` reports unformatted files and exits 1.
- Test: area Editor, `packages/e2e/editor/format/mf-fmt.spec.ts`. New fixture app `packages/e2e/fixtures/apps/lint-format/` with its own `.oxfmtrc.json` and `Messy.ucf` (unformatted `<react>`, `<vue>`, `<svelte>`, `<style lang="scss">`). On a temp copy, the real `mf-fmt`:
  1. Each formatted block equals what the real oxfmt CLI prints for the same text (`oxfmt --stdin-filepath <block file path>` in the same folder), so our config handling matches the CLI.
  2. The `<svelte>` block and everything outside the blocks are unchanged.
  3. A second run changes nothing, and `--check` exits 0.
  4. The formatted copy still passes the real `mf-tsc`, and the real Vite build of each target (M3, M4, M5 plugins) still succeeds.
  5. `--check` on the untouched fixture: exit 1, stdout exactly the `unformatted` line for `Messy.ucf` and the summary line.
  6. `--check --format json` on the untouched fixture: the exact document, one `unformatted` finding at the first character that differs, its `block` set, `changed: ['Messy.ucf']`.
  7. One file and one folder: the copy also holds `Messy.ucf` under `nested/`, `.hidden/` and `old/`, with `old/**` in `ignorePatterns`. `mf-fmt nested` changes only `nested/Messy.ucf`, stdout exactly `mf-fmt: formatted 1 of 1 files`; `mf-fmt Messy.ucf --format json` changes only the other, the exact `{findings: [], ..., files: 1, changed: ['Messy.ucf']}`. A run with no path leaves `.hidden/` and `old/` as written.
  8. Nearest config: `nested/` gets its own `.oxfmtrc.json` (another `printWidth`); `nested/Messy.ucf` follows it, `Messy.ucf` the app's.
  9. A block that does not parse (a temp edit): exit 1, `format-error` at its `.ucf` position, the file unchanged. A copy of `components/invalid/DuplicateReact.ucf`: its `duplicate-target` findings, the file unchanged.
  10. Exit 2, stdout empty, one stderr line: an unknown option, a `.ts` file as a path, a missing path, a folder with no `.ucf` file, `old/Messy.ucf` named (`is ignored by .oxfmtrc.json`), an `.oxfmtrc.json` that is not JSON, not an object or of the wrong shape, one with `printWidth: 1000` (oxfmt's own message, naming the `.editorconfig` when the value came from there), and a copy outside the repo (`os.tmpdir()`) with no oxfmt to load.
  11. `--help`: exit 0, the exact help.

  A loop over `BLOCK_KINDS` checks that `blockFile` names a file for every tag, so a new block kind cannot skip it.
- Status: done

### 7.7 `mf-fmt`: Svelte blocks follow oxfmt's `svelte` option

oxfmt 0.67.0 formats `.svelte` files when the config sets `svelte` (true or an object) and `svelte` is installed. It is off by default.

- Build: `formatUcf` adds `.svelte` to the endings it sends when the block file's resolved config (its `overrides` included) turns `svelte` on (`true` or an object). oxfmt requires `svelte/compiler` from its own folder, so `formatUcf` resolves it from there first (`resolveInProject(root, name, missing)` in `packages/language-tools/src/files.ts`, now exported). If it cannot be loaded, the `<svelte>` blocks stay as written, the other blocks are still formatted, and the result says `missingSvelte: true`; `mf-fmt` then gives one file-less warning per run, code `missing-svelte` (new in core's `DiagnosticCode`), message `oxfmt cannot load svelte/compiler, so <svelte> blocks stay as written; add svelte to devDependencies`, exit 0. Markup Svelte cannot parse gives `format-error` on the `<svelte>` opening tag (7.6's rule for an error with no position). Updates spec 6.1, whose "not Svelte" line was out of date.
- Deliverable: a project that turns on oxfmt's Svelte formatting gets its `<svelte>` blocks formatted too; any other project keeps them as written.
- Test: area Editor, `packages/e2e/editor/format/svelte.spec.ts`. New fixture `packages/e2e/fixtures/apps/lint-format-svelte/` with `.oxfmtrc.json` `{"svelte": true}` and a copy of `Messy.ucf`. Real `mf-fmt` on a temp copy: the `<svelte>` block now equals the real oxfmt CLI output for the same text (`--stdin-filepath Messy.ucf.svelte.svelte`), a second run changes nothing, and the real Svelte build (M5) of the result still succeeds. An override with `svelte: false` for `nested/*.svelte` keeps that block as written; markup that does not parse gives the `format-error`. A copy outside the repo whose oxfmt (a real copy, with no svelte beside it) cannot load `svelte/compiler` gets the one `missing-svelte` warning for two files, both `<svelte>` blocks as written, the other blocks formatted. The `lint-format/` fixture, without the option, keeps it as written (7.6 test still green).
- Status: done

### 7.8 `mf-lint`: per-block files through oxlint, positions mapped back

- Build: `packages/language-tools/src/lint/index.ts` exports `lintUcf(files, {root})`, and the bin `mf-lint [--deny-warnings] [--format text|json] [paths…]`, its paths through `ucfFiles` (7.6). Files are grouped by their nearest `.oxlintrc.json`; oxlint has no stdin mode, so per group:
  1. Make a temp folder (`os.tmpdir()`), and write each target block's text there as `<relative path>/Card.ucf.<tag><ext>` (`blockFile(<relative path>, block)`), keeping the path relative to the project root so the config's `overrides` globs still match. `<style>` blocks are skipped: oxlint does not lint CSS.
  2. Write a wrapper `.oxlintrc.json` in the temp folder: `{"extends": ["<the group's .oxlintrc.json>"], "globals": {"$style": "readonly"}}` (no `extends` when the group has no config), plus each named module (`<style module="classes">` adds `classes`). The project config is never changed.
  3. Run the project's own `oxlint -c <wrapper> -f json` once over the group's block files, from the temp folder. An exit other than 0 or 1, or a stdout that is not its JSON report, is exit 2.
  4. Map each finding back: `.ucf` offset = block `contentStart` + `labels[].span.offset`; line and column are recomputed on the `.ucf` text. For `.vue` and `.svelte` block files oxlint already reports offsets from the start of the file, so the same sum holds.
  5. Delete the temp folder in a `finally`.

  `lintUcf` returns oxlint's diagnostics (`message`, `code`, `severity` with `advice`, `url`, `help`), each with the `.ucf` path and its span in `.ucf` offsets: what the server needs (7.11). The bin runs on `runCommand` as "Decision: every command follows the command rules" says and turns each diagnostic into a `Finding`: oxlint's `code`, `message`, severity (`advice` becomes `warning`) and position, `block` and `framework` set to the block's tag, no `help` or `url`. Exit 1 on any error, or on any warning with `--deny-warnings`, through the new `CommandResult.warningsFail`. A splitter error is a finding at its position (`findingOf`). oxlint that cannot be loaded from the project, or exits with anything but 0 or 1, is exit 2.

- Deliverable: `mf-lint` reports oxlint findings for every target block, at the right `.ucf` line and column, for one file, a folder or every `.ucf` file under the current folder.
- Test: area Editor, `packages/e2e/editor/lint/mf-lint.spec.ts`. Adds `.oxlintrc.json` (with `no-debugger` and `no-undef` as errors, and an `overrides` entry for `**/*.tsx`) and `Lint.ucf` to `packages/e2e/fixtures/apps/lint-format/`: a `debugger;` and an unused variable in each target block, and `$style.card` used in `<react>` and `<svelte>`. Real `mf-lint --format json`: exactly the expected rule codes, and for each one the `.ucf` text from its `line` and `column` to its `end` is the offending code (`debugger;`, the variable name). No `no-undef` for `$style`. The `overrides` rule applies to the `<react>` block only. After the run, no temp file is left. `Clean.ucf` in the same app gives no findings and exit 0. The command rules, on temp copies:
  1. The readable output and the `--format json` document, exact (`block` and `framework` on each finding).
  2. One file: `mf-lint Clean.ucf` gives only the summary line. One folder: copies of `Lint.ucf` under `nested/`, `.hidden/` and `old/`, with `old/**` in the app config's `ignorePatterns`; `mf-lint nested` reports only `nested/`'s findings, and a run with no path reports none from `.hidden/` or `old/`.
  3. Nearest config: `nested/` gets its own `.oxlintrc.json` with `no-debugger` off; `nested/Lint.ucf` has no `no-debugger` finding, `Lint.ucf` keeps its own (two groups, two oxlint runs).
  4. A copy with the `debugger;` lines removed (warnings only) exits 0, and 1 with `--deny-warnings`.
  5. A copy of `components/invalid/DuplicateReact.ucf`: its `duplicate-target` findings, exit 1.
  6. Exit 2, stdout empty, one stderr line: an unknown option, a `.ts` file as a path, a missing path, a folder with no `.ucf` file, `old/Lint.ucf` named (`is ignored by .oxlintrc.json`), a copy outside the repo (`os.tmpdir()`) with no oxlint to load, and an `.oxlintrc.json` that is not JSON (oxlint's own message).
  7. `--help`: exit 0, the exact help.

### 7.9 Propose `.ucf` support to oxc, with a canary test

- Build: open an issue (and, if the maintainers agree, a PR) on `oxc-project/oxc` proposing a `.ucf` loader next to the `.vue` / `.svelte` / `.astro` ones in oxlint's partial loader. The issue gives the format rules (spec 2 and 3.2: raw-text root split, the first closing tag wins), what to lint per block (`<react>` whole as TSX, `<vue>` and `<svelte>` through their existing loaders at an offset) and a link to our lint fixtures. As a second option it asks for a pluggable file loader. The link goes into docs/plan.md under milestone 7.
- Deliverable: the upstream proposal, linked from the plan, and a test that tells us when it lands.
- Test: area Editor, `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`. Runs the real pinned `oxlint -f json` directly on `packages/e2e/fixtures/apps/lint-format/` and checks that it lints no `.ucf` file today. When an oxlint upgrade starts reading `.ucf` files, this test fails with a message saying to compare its findings with `mf-lint` and switch `mf-lint` to plain oxlint.

### 7.10 Language server: formatting (format on save)

- Build: a Volar service plugin `multifront-format` in `packages/language-tools/src/server/` answers `textDocument/formatting` for the root `.ucf` document with one whole-document edit from `formatUcf`. Every embedded code mapping sets `format: false`, so the CSS, TypeScript, Vue and HTML services never format a block on their own. oxfmt is loaded from the workspace folder (the project's own install); if it is missing, formatting is off and the server logs one line. When `formatUcf` returns `missingSvelte`, the server also logs one line, as `mf-fmt` warns, and still applies the edit. `packages/vscode` adds `configurationDefaults` `"[ucf]": {"editor.defaultFormatter": "<publisher>.multifront-vscode"}`, so VS Code's `editor.formatOnSave` uses us.
- Deliverable: Format Document and format on save in VS Code give exactly what `mf-fmt` writes.
- Test: area Editor, `packages/e2e/editor/server/format.spec.ts`. Real server over LSP on a temp copy of `lint-format/`: open `Messy.ucf`, send `textDocument/formatting`, apply the edits. The text equals the real `mf-fmt` output on another copy, byte for byte. The test repeats this on `lint-format-svelte/` (Svelte block formatted) and on a copy with no oxfmt installed (no edits, no crash).

### 7.11 Language server: lint diagnostics

- Build: a Volar service plugin `multifront-lint` gives `provideDiagnostics` for the root `.ucf` document through `lintUcf`, fed the in-memory text, not the file on disk. It runs on open and on change (Volar's diagnostic debounce), and again when `.oxlintrc.json` changes (`workspace/didChangeWatchedFiles`). Findings become LSP diagnostics with `source: 'oxlint'`, `code`, and `codeDescription.href` from the oxlint `url`; severity error / warning / advice maps to 1 / 2 / 3. oxlint is loaded from the workspace folder, like oxfmt.
- Deliverable: oxlint findings show in VS Code in every target block, live, matching `mf-lint`.
- Test: area Editor, `packages/e2e/editor/server/lint.spec.ts`. Real server over LSP: open `Lint.ucf`, pull diagnostics. They match the real `mf-lint --format json` findings on the same file (`code`; `line`, `column` and `end` as the range; `severity`). Then a real `didChange` removes the `debugger;` from `<vue>` and that one diagnostic goes away, without saving. Then the test edits `.oxlintrc.json` on disk to turn `no-debugger` off and the remaining ones go away.

### 7.12 The three commands in CI, and from the packed package

- Build:
  - `packages/e2e/fixtures/tsconfig.fixtures.json`: includes every valid fixture component and app, leaves out `types-broken/`, `lint-format/`, `lint-format-svelte/`, `components/invalid/` and `components/react/fuzz-found/`.
  - `packages/e2e/editor/gate.spec.ts`: runs the real `mf-tsc -p packages/e2e/fixtures/tsconfig.fixtures.json --format json` and the real `mf-lint --format json` over the same valid fixtures with the repo's `.oxlintrc.json`. Both must exit 0 with `errorCount: 0`; on failure the test prints the readable output. A type or lint error found in an earlier milestone's fixture is fixed in this PR (AGENTS.md: found issues are fixed). A fixture that breaks a lint rule on purpose (a splitter edge case in `TsxEdges.ucf`, say) is left out by name, with a one-line reason, instead of being changed.
  - Speed, in the gate spec: it times the real `mf-tsc` on `Card.ucf`, on one fixture folder and on the whole `tsconfig.fixtures.json`, and the real `mf-lint` on one file and on every fixture, median of 5 fresh runs each, and prints the numbers in the test log (no time assertion). The step writes the CI numbers into this document.
  - `packages/e2e/consumer/language-tools.spec.ts`: packs `@multifront/language-tools` with M6's helper, installs it with `oxlint`, `oxfmt` and `typescript` into a fresh real project holding a copy of `types-every-target/` and `lint-format/`, and runs the installed `mf-tsc`, `mf-lint` and `mf-fmt --check` bins from `node_modules/.bin`. Each bin also answers `--help` (exit 0) and an unknown option (exit 2, stdout empty).
- Deliverable: every PR fails when a fixture breaks one target or gets an oxlint error, the three bins are proven to work from the published package, not only from source, and the one-file speed is measured.
- Test: the two spec files above (areas Editor and Consumer). The gate spec also runs both commands on a temp copy of the fixtures with `ReactBreaks.ucf` added and checks exit 1, so the gate cannot pass silently. That copy lies under `packages/e2e/.tmp/`, which the repo's `.oxlintrc.json` ignores (`**/.tmp/**`): the copy gets its own `.oxlintrc.json` with the repo's rules and no `ignorePatterns`.

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

- Bins of `@multifront/language-tools`: `mf-tsc`, `mf-lint`, `mf-fmt`, on the command rules of spec 8.1. Used by library authors in their own CI and by coding agents on one file at a time.
- What `runCommand` gains here: `CommandSpec.paths`, `short` in `CommandOption`, `CommandResult.warningsFail`. The codes `unformatted` and `format-error` in core's `DiagnosticCode`. `ucfFiles(paths, ignored, otherFiles)` in `packages/language-tools/src/files.ts`. Any later command that takes `.ucf` paths reuses them.
- Functions exported from `@multifront/language-tools`: `formatUcf(fileName, source, config)` (returns `{text, findings, missingSvelte}`) with its config from `findFormatConfig(fileName, root)`, `lintUcf(files, {root})` (returns oxlint's diagnostics in `.ucf` offsets). Used by the server, and by any other editor setup (WebStorm, Neovim) that loads the server from npm.
- `blockFile(fileName, block)` in `packages/language-tools/src/blocks/blockFile.ts`. A new block kind must give its file ending here; the registry loop of 7.6 fails otherwise.
- Every served target's script (`targetScriptName`, the editor kind's `serviceScript`) as a root of `mf-tsc`'s program, through `programTargetScripts`. A new target row is checked by `mf-tsc` once its kind has a `serviceScript`.
- `packages/e2e/editor/gate.spec.ts` and `packages/e2e/fixtures/tsconfig.fixtures.json`. Every fixture added later must type-check in every target and be oxlint clean.
- `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`. Tells us when upstream `.ucf` support lands.
- `pnpm devx vsix`, `packages/vscode/multifront-vscode-<version>.vsix` and `.github/workflows/vscode-release.yml`. Used by every release.
- Fixtures: `packages/e2e/fixtures/apps/types-every-target/`, `types-broken/`, `lint-format/`, `lint-format-svelte/`, `svelte-markup/`.

## Exit test

`packages/e2e/editor/vscode/exit.spec.ts` (area Editor), on a copy of `fixtures/components/Card.ucf` (all three targets) inside a small project with `.oxlintrc.json`, `.oxfmtrc.json` and a tsconfig:

1. Real `mf-tsc`, `mf-lint` and `mf-fmt --check` all exit 0.
2. The test edits only the `<svelte>` block to pass a number to a `string` prop and adds `debugger;` to the `<vue>` script. Real `mf-tsc` now fails with one error inside the `<svelte>` block; real `mf-lint` reports `no-debugger` at the `<vue>` line. The agent's view of the same: `mf-tsc Card.ucf --framework svelte --format json` gives exactly that one finding, with `block` and `framework` set to `svelte`, and `--framework react` on the same file exits 0; `mf-lint Card.ucf --format json` gives the `no-debugger` finding with `block: 'vue'`.
3. A real VS Code with the packed `.vsix` installed opens the same file and shows the same two findings at the same ranges.
4. Format Document in that VS Code gives byte for byte what `mf-fmt` writes on a second copy.
5. In that VS Code, completion after `<input bi` in the `<svelte>` markup lists `bind:value`, and after `<Icon ` (the test adds the `Icon.ucf` of 7.5 next to the copy and imports it) lists `name` and `size`.

All of it with real tools: no mock server, no fake oxlint output, no stubbed VS Code.

## Risks and open questions

Risks:

- **Volar has no extra service scripts on the `tsc` path either.** `@volar/typescript` 2.4.28 `proxyCreateProgram` warns `getExtraServiceScripts() is not available in this use case.`, as its tsserver plugin does (spike 1, answer 3). 7.2 makes each target's script a root of `mf-tsc`'s program instead, as M4 does in tsserver.
- **oxfmt and oxlint are young.** oxfmt is 0.x and oxlint's JSON shape is not a promised contract. Both are exact-pinned in the repo, and the parity tests (7.6, 7.8, 7.11) fail on any change in a bump. Users bring their own versions through the peer ranges.
- **Svelte formatting depends on install layout.** oxfmt loads `svelte/compiler` from its own location. With pnpm's strict layout this works only when `svelte` is installed so pnpm links it as oxfmt's peer. 7.7 warns and skips instead of failing.
- **Linting a block alone.** Block files sit in a temp folder, so rules that follow imports (`import/no-cycle`) do not see across files, and type-aware linting (`--type-aware`, tsgolint) is not supported. Upstream support (7.9) would fix both.
- **`mf-tsc` builds on TypeScript's JS API.** It creates its program through Volar's `proxyCreateProgram`, the proxy `vue-tsc` gets through `runTsc`. The native TypeScript port (TypeScript 7) has no such API to proxy. `vue-tsc` faces the same problem; we follow Volar's answer when it comes.
- **One file still parses the whole project.** A one-file `mf-tsc` check costs program creation (every file parsed and bound) plus that file's check. A long-lived process would remove the parsing, and is out of scope.
- **`svelte2tsx` output shape.** Prop completions (7.5) map into the props object `svelte2tsx` generates. Its shape can change between versions; it is pinned, and the 7.5 test catches a change.
- **Packaging.** `vsce` and pnpm workspaces clash on dependencies, hence `--no-dependencies` and a full bundle. The TypeScript plugin folder under the extension's `node_modules` must survive packing; the 7.13 test checks the unzipped file. Real VS Code tests need a display (M2's harness starts Xvfb) and a pinned VS Code download, cached in CI.
- **Store accounts.** Marketplace tokens expire (Azure DevOps PATs); Open VSX needs the namespace claimed and the Eclipse publisher agreement signed. A maintainer does this once by hand.
- **Other extensions.** Vue's and Svelte's extensions do not claim `.ucf`, and the default formatter is set only for `[ucf]`. The oxc VS Code extension ignores `.ucf` today; if upstream support lands it would lint `.ucf` too and show findings twice.

Open questions:

1. **Settled:** spec 6.1 on Svelte. oxfmt 0.67.0 formats `.svelte` with its `svelte` option; `<svelte>` blocks stay as written by default and are formatted only when the project turns the option on (7.7), which updated spec 6.1.
2. **Settled:** block text is written flush left (7.6). `mf-fmt` writes block text flush left, like Vue's default for `<script>` and `<style>`. The spec's examples indent block text by two spaces. Re-indenting after oxfmt would change multi-line template literals, so this plan does not. Is flush left acceptable?
3. **`.svelte` importers on the command line.** `mf-tsc` checks `.ts`, `.tsx`, `.vue` and every `.ucf` target, but not `.svelte` files that import `.ucf` (svelte-check does not run our TypeScript plugin). Add `.svelte` files to `mf-tsc` through `svelte2tsx`, or leave it?
4. **Settled:** M4's `types()` returns the script `@vue/language-core` generates and M5's the `svelte2tsx` output, both with the template and markup check code.
5. **Publisher id and pre-release.** Which Marketplace publisher and Open VSX namespace? Publish 0.x versions on the pre-release channel (`--pre-release`)? The stores do not accept semver pre-release tags like `0.1.0-beta.1`, which matters for the one-version rule.
6. **Settled:** lint and format read the block's own text; architecture.md already says so.

## Out of scope

- `mf-lint --fix` and lint code actions in the editor.
- Range formatting and format on type.
- Formatting `<style lang="stylus">` or any language oxfmt does not format (stays as written).
- `mf-tsc` emitting files. Declarations come from the library build (M6).
- `mf-tsc --watch`, or any long-lived check process.
- Reuse between `mf-tsc` runs (TypeScript's incremental build info): it keeps the diagnostics of unchanged files and still parses every file, so it cannot speed up the one-file check (decided in M6.1, 6.1.6).
- oxlint and oxfmt configs written in JS or TS (`oxfmt.config.ts`). Only JSON / JSONC configs are read.
- Type-aware lint rules.
- Packaging for other editors (WebStorm, Neovim). They can load the server and the TypeScript plugin from the npm package.
- Proposing `.ucf` support to oxfmt upstream (the 7.9 issue mentions it as a follow-up only).
- Running `mf-fmt` over this repo's own files.
