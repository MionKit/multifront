---
type: feature
spec: full-plan
status: done
created: 2026-10-15
milestone: 7
step: 7.6
---

# mf-fmt: oxfmt's format() block by block

## Problem

Nothing formats a `.ucf` file. The oxfmt CLI skips unknown file types; its JS API, `format(fileName, source, options)`
(oxfmt 0.67.0, root devDependency), formats one text by its file ending but takes only already-resolved options: no
config lookup, no `overrides`, no `ignorePatterns`, no `.editorconfig`. Milestone 7 step 7.6 adds `formatUcf()` and the
`mf-fmt` bin: split the file, format each block's own text as its block file's language, put it back, with the config
read as the oxfmt CLI reads it, on the command rules (spec 8.1).

Checked before planning (oxfmt 0.67.0 CLI, `format()`, and its Rust source at tag `oxfmt_v0.67.0`,
`apps/oxfmt/src/core/config/`):

- The CLI takes the nearest `.oxfmtrc.json` / `.oxfmtrc.jsonc` above each file; a nested one replaces its parent,
  nothing inherited. Comments are stripped (JSONC) for both names.
- Order (later wins): base options, each matching `overrides[]` entry's `options` in array order, then `.editorconfig`
  filling only fields still unset.
- `overrides` `files` / `excludeFiles` are matched against the path relative to the config's folder; a leading `./` is
  stripped and anchors the pattern there, as a `/` inside it does; any other pattern becomes `**/<pattern>`.
- `ignorePatterns`: gitignore lines rooted at the config's folder, matched against the file or any parent.
- `.editorconfig`: ONE file, the nearest at or above the cwd (not above the file). Its sections match the whole file
  path relative to its own folder, `*` crossing `/` (found in review, on the CLI): `[*.tsx]` matches
  `src/a.tsx`, `[a.tsx]` only a top-level `a.tsx`, `[/a.tsx]` nothing. Fields: `max_line_length`→`printWidth`, `end_of_line`→`endOfLine`,
  `indent_style`→`useTabs`, `tabWidth` from `indent_size` only when `useTabs` is false, else from `tab_width`,
  `insert_final_newline`→`insertFinalNewline`, `quote_type`→`singleQuote`.
- `format()` errors come in `{code, errors}`, `code` = input on error. TSX / CSS / SCSS / Less parse errors carry
  `labels[].start` (a UTF-8 byte offset in the text sent, found in review); Vue structure errors carry no labels, Prettier's `(line:col)` (1-based)
  ends the message's first line. A bad option value gives `Failed to parse configuration: ...` with no labels; unknown
  keys are ignored. `.svelte` without the `svelte` option gives "plugin is not enabled"; empty input gives `''`.

## Decisions

Answers from the run-milestone orchestrator:

1. `.editorconfig`: the oxfmt CLI's rule, the nearest at or above `root` (the cwd for `mf-fmt`, the workspace folder
   for the server in 7.10), so `mf-fmt` matches the CLI (7.6 test 1). The 7.6 Build line says so.
2. Glob matching: `minimatch` 10.2.6 (`dot: true`) and `ignore` 7.0.9, exact-pinned runtime dependencies of
   `@multifront/language-tools`, already in the lockfile. The milestone's "Outside the milestones" list names both.
3. oxfmt peer range: `>=0.67.0 <1`, optional.
4. No fuzz sweep in 7.6 (the milestone puts none here).
5. Accepted: `blockFile(fileName, block)`, `ucfFiles(paths, ignored, otherFiles)`, the new export
   `findFormatConfig(fileName, root)` and three extra exit 2 config cases (spec 8.1, bad config); the milestone's step
   text, its "Decision: every command follows the command rules" bullet and "Hands to later milestones" follow.

Review (automatic mode) changed what shipped:

- `mf-fmt` writes no file until every file formatted, so a config error in a later file (exit 2) leaves all as written.
- A value oxfmt rejects names the `.editorconfig` when the `.oxfmtrc.json` options alone pass.
- `overrides`, their `files` / `excludeFiles` / `options`, and `ignorePatterns` of the wrong shape are exit 2 naming
  the file.
- `.editorconfig` sections go through a small glob-to-regex step (`sectionMatches`), not `minimatch`: oxfmt's reader
  lets `*` cross `/` and never prefixes `**/`, which `minimatch` cannot express.
- oxc's byte offsets become UTF-16 offsets before they map into the `.ucf` file.
- `run` calls `findFormatConfig` per file (no cache of its own); `projectImport` and `projectTypeScript` share one
  resolver; oxfmt's own `format()` types are used inside `format/index.ts`.
- Kept: the exported option types stay our own, since oxfmt is an optional peer and the published `.d.ts` must not
  name it; `packages/e2e/editor/lib/format.ts` stays a shared helper, for the 7.7 and 7.10 specs on the same fixture.
- More tests: CSS, Less, Stylus and an empty block; no `.oxfmtrc.json` with every `.editorconfig` field and section
  rule; `.oxfmtrc.jsonc` with a comment and a trailing comma; `excludeFiles`, `./`-anchored and folder overrides;
  `--check` over two files; a first-line, a position-less and a non-ASCII `format-error`; `. holds no .ucf file`.

## Plan

### 1. Core: two codes, one export (`packages/core`)

- `src/types.ts` `DiagnosticCode` gains `'unformatted' | 'format-error'`.
- `src/index.ts` also exports `createDiagnostic` from `diagnostics.ts`.

### 2. Block file names (`packages/language-tools/src/blocks/blockFile.ts`, new)

`blockFile(fileName, block)` returns `${fileName}.${tag}${ending}`: `Card.ucf.react.tsx`, `Card.ucf.vue.vue`,
`Card.ucf.svelte.svelte`, `Card.ucf.style.css`; a string `<style lang>` gives `.${lang}`, else `.css`. A
`Record<BlockTag, …>` lookup, so a new tag fails typecheck too. Exported from `@multifront/language-tools`.

### 3. Shared file helpers (`packages/language-tools/src/files.ts`)

- `ucfFiles(paths, ignored, otherFiles)`: `paths` absolute, `[]` = the cwd; `ignored(file)` returns the config that
  ignores it (shown relative to the cwd) or undefined. Named file not `.ucf` → `src/main.ts is not a .ucf file;
  <otherFiles>`; named file ignored → `old/Messy.ucf is ignored by .oxfmtrc.json`; a folder gives its `.ucf` files
  through `filesUnder(dir, '.ucf')`, ignored ones dropped silently; nothing left → `empty holds no .ucf file`
  (`. holds no .ucf file` with no path). One sorted, de-duplicated list.
- `nearestFile(dir, names)`: the first of `names` in `dir` or a parent folder.
- `parseJsonc(file, root)`: comments and trailing commas blanked to spaces (offsets kept), `JSON.parse`; an error is
  `<file relative to root>: <Node's message>`.
- `projectImport(root, name, missing)`: `createRequire(root/package.json).resolve(name)`, then `import()`.

### 4. Format config (`packages/language-tools/src/format/config.ts`, new)

- Types `UcfFormatConfig` (`root`, `file?`, `options`, `overrides`, `ignorePatterns`, `editorconfig?`) and
  `FormattedUcf` (`{text, findings}`) in `src/types.ts`, exported.
- `findFormatConfig(fileName, root)`: nearest `.oxfmtrc.json` / `.oxfmtrc.jsonc` above the file, the nearest
  `.editorconfig` at or above `root` (`[glob]` sections, `key = value`, `#` / `;` comments). A config that is not an
  object is `<file>: not a JSON object`; wrong-shape `overrides` / `ignorePatterns` say which.
- `formatOptions(config, blockPath)`: `own` = options and matching overrides (`minimatch`, `dot: true`); `options` =
  `own` plus the `.editorconfig` sections matching as oxfmt matches them, filling unset fields, as the CLI does.
- `isIgnored(config, fileName)`: `ignore` over `ignorePatterns`, on the `.ucf` path relative to the config's folder.

### 5. `formatUcf` and `mf-fmt` (`packages/language-tools/src/format/index.ts`, new)

`formatUcf(fileName, source, config)`:

1. `splitBlocks`; a splitter error → `{text: source, findings}` through `findingOf`.
2. oxfmt from `projectImport(config.root, 'oxfmt', …)`; missing → throws
   `oxfmt is not installed in <root>; add it to devDependencies`.
3. Blocks whose `blockFile` ends in `.tsx`, `.vue`, `.css`, `.scss` or `.less` go to `format(file, block.content,
   formatOptions(config, file))`; any other block stays as written.
4. `Failed to parse configuration: <why>` → throws `<config relative to root>: <why>` (exit 2 in `mf-fmt`); the
   config is the `.editorconfig` when `own` alone passes.
5. Any other error → one `format-error` per block at its first error (label span, bytes to UTF-16; else the
   message's `(line:col)`; else the opening tag), message `<tag> does not parse: <first line>` without a leading
   `SyntaxError: ` and the trailing `(line:col)`, and the file stays as is.
6. Else each block's content becomes `nl + code with trailing line breaks trimmed + nl` (`''` stays `''`), `nl` from
   the block's resolved `endOfLine`, spliced between `contentStart` and `contentEnd` only.

`runMfFmt(args)` = `runCommand(MF_FMT, args, run)`, help as the milestone says (`--check` "write nothing; list the files
that are not formatted", example `mf-fmt --check src/Card.ucf`). `run`: oxfmt loaded from the cwd first;
`findFormatConfig` per file; `ucfFiles(paths, …, 'format it with oxfmt')`; changed files are written once every file
formatted, or with `--check` each gets
one `unformatted` error at the first differing character (zero length, `block` set, message `not formatted; run mf-fmt
<file>`). Summary `formatted <changed> of <files> files` / `<changed> of <files> files not formatted`. JSON data
`{files, changed}`.

Wiring: `bin/mf-fmt.js` through the private import `#fmt`, `bin.mf-fmt`, dependencies `ignore` 7.0.9 and
`minimatch` 10.2.6, optional peer `oxfmt` `>=0.67.0 <1` with devDependency `oxfmt` 0.67.0. `src/index.ts` exports
`formatUcf`, `findFormatConfig`, `blockFile`, `UcfFormatConfig`, `FormattedUcf`.

### 6. Fixture app `packages/e2e/fixtures/apps/lint-format/` (new)

`Messy.ucf` (valid, unformatted `<react>`, `<vue>`, `<svelte>`, `<style module lang="scss">`, an HTML comment between
blocks), `.oxfmtrc.json` (`singleQuote`, `semi: false`, overrides `*.vue` `semi: true`, `*.tsx` excluding `*.react.tsx`,
`./Messy.ucf.style.scss`, `nested/*.vue`; `ignorePatterns: ["old/**"]`),
`.editorconfig` (`[*]` spaces, `indent_size = 4`, `max_line_length = 100`; `[*.tsx]` `max_line_length = 72`),
`tsconfig.json`, `vite.config.ts` (react, vue, svelte, multifront), and `react.ts`, `vue.ts`, `svelte.ts`, each
importing `Messy.ucf` in one framework.

### 7. Docs and milestone

- `docs/architecture.md`: an `mf-fmt` bullet after `mf-tsc`'s.
- `README.md`: the language-tools row names `mf-fmt`.
- Milestone: step text and hand-offs with the shipped names, the two dependencies under "Outside the milestones",
  open question 2 settled, `- Status: done`.

## Tests

Area Editor, `packages/e2e/editor/format/mf-fmt.spec.ts`, helpers in `packages/e2e/editor/lib/format.ts`
(`oxfmtCli()` spawns the real oxfmt CLI), `runMfFmt` in `lib/commands.ts`. Real `mf-fmt` on `copyApp('lint-format')`
copies; runs on this host and in CI's `check` job; nothing new to install.

1. Each formatted `<react>`, `<vue>`, `<style>` block equals `'\n' +` the real `oxfmt --stdin-filepath
   Messy.ucf.<tag><ext>` output for the same text, from the copy's folder.
2. The `<svelte>` block and the text outside the blocks are byte-identical.
3. A second run changes nothing; `--check` exits 0.
4. The formatted copy passes the real `mf-tsc`, and the real Vite build of each target succeeds.
5. `--check` on the untouched copy: exit 1, the exact `unformatted` line and summary.
6. `--check --format json`: the exact document.
7. One file, one folder, a file named twice; `nested/`, `.hidden/`, `old/` copies.
8. Nearest config: `nested/.oxfmtrc.jsonc` (a comment, a trailing comma), parity with the CLI there too.
9. A `<react>` and a `<vue>` block that do not parse, and `DuplicateReact.ucf`: exact findings, file unchanged.
10. Exit 2 cases of the milestone, plus `. holds no .ucf file`, a folder whose only `.ucf` file is ignored, an
    `.oxfmtrc.json` that is not JSON, not an object, of the wrong shape, with `printWidth: 1000`, a rejected value
    from the `.editorconfig`, and a later file's bad config (no file written).
11. `--help` / `-h`: the exact help.
12. A loop over core's `BLOCK_KINDS`: `blockFile` names a file for every tag.

## Docs

Architecture bullet, README row, milestone step text and hand-offs. Spec unchanged (its 6.1 Svelte line is 7.7's).

## Fuzzing

None (decision 4).

## Out of scope

Svelte formatting (7.7), server formatting (7.10), JS/TS oxfmt configs, `.prettierignore` / `.gitignore`, range
formatting, running `mf-fmt` over this repo.

## Done when

- `mf-fmt` formats one file, a folder or every `.ucf` file under the cwd; `--check` reports and exits 1; every test
  above green in `pnpm devx check`.
- The milestone step reads `- Status: done`, its names matching what shipped; this todo is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
