---
type: feature
spec: full-plan
status: done
created: 2026-10-15
milestone: 7
step: 7.7
---

# mf-fmt: Svelte blocks follow oxfmt's svelte option

## Problem

`formatUcf` (7.6) sends only blocks whose block file ends in `.tsx`, `.vue`, `.css`, `.scss` or `.less`
(`packages/language-tools/src/format/index.ts:28`), so `<svelte>` blocks are never formatted. oxfmt 0.67.0 formats
`.svelte` when the resolved config turns `svelte` on. Spec 6.1 still says oxfmt cannot format Svelte.

Checked before planning (the repo's oxfmt 0.67.0):

- `format('X.ucf.svelte.svelte', text, {svelte: true})` and `{svelte: {}}` format; `{}` and `{svelte: false}` return
  the text with one error "Cannot format `.svelte`: `svelte` plugin is not enabled in resolved config".
- oxfmt loads `prettier-plugin-svelte` (bundled), which runs `require("svelte/compiler")` through
  `createRequire(import.meta.url)` inside oxfmt's own `dist/`: svelte resolves from oxfmt's folder, not the project.
  In this repo pnpm links oxfmt as `oxfmt@0.67.0_svelte@5.57.0`, svelte as its peer.
- oxfmt copied outside the repo without svelte: `format()` returns the text and the error
  `Error: Cannot find module 'svelte/compiler'` on every call (the CLI exits 2 the same way).
  `createRequire(<oxfmt's resolved entry>).resolve('svelte/compiler')` throws `MODULE_NOT_FOUND` there and succeeds
  in the repo.
- Svelte markup errors carry no labels and no `(line:col)`; the first message line is Svelte's
  (`expected_whitespace: Expected whitespace`). Its code frame counts lines of a text the plugin trimmed and whose
  `<script>` / `<style>` it shrank, so it does not map back.
- A `<script>` syntax error inside a Svelte block gives no error: oxfmt leaves that script as is, formats the rest and
  prints a `oxfmt::textToDoc() failed` stack on stderr; the oxfmt CLI does exactly the same. A `<vue>` `<script>` error
  is as silent (7.6).

## Decisions

Answers from the run-milestone orchestrator:

1. The "svelte cannot be loaded" warning is one file-less finding per run, `warning missing-svelte`, exit 0 (spec 8.1:
   one finding shape, stderr only on exit 2; precedent: `mf-tsc`'s file-less TS2688). No existing code fits
   (`TargetErrorCode`, `LibraryErrorCode`, `missing-preprocessor` names a style preprocessor), so `missing-svelte` is new.
2. A Svelte parse error lands on the `<svelte>` opening tag, 7.6's rule for an error with no position.
3. 7.10's Build line gets a clause: `missingSvelte` from `formatUcf` → the server logs one line.
4. No fuzz test or fixture sweep; the CLI parity test covers it.

Review (automatic mode) changed what shipped:

- No `projectResolve` wrapper: `resolveInProject` is exported instead.
- `oxfmtLoadsSvelte` treats only `MODULE_NOT_FOUND` as missing; a broken svelte install throws its own error.
- More tests: `"svelte": {}`, the warning beside a `format-error`, no warning without a `<svelte>` block.
- Kept: the `lint-format-svelte/` fixture app and the separate `svelte.spec.ts`, both named by the milestone step (and
  the app reused by 7.10).

## Plan

### 1. Core: one code (`packages/core/src/types.ts:86`)

`DiagnosticCode` gains `'missing-svelte'`.

### 2. Resolve oxfmt's entry file (`packages/language-tools/src/files.ts:26`)

`resolveInProject(root, name, missing)` is exported (it was private); `formatUcf` takes oxfmt's entry file from it.

### 3. `formatUcf` (`packages/language-tools/src/format/index.ts:62-91`)

- Per block first: its `blockFile` and `formatOptions(config, file)`.
- Sent when its ending is in `FORMATTED`, or it ends in `.svelte` and its resolved `options.svelte` is `true` or an
  object (`overrides` count: `{"files": ["*.svelte"], "options": {"svelte": false}}` turns it off).
- Private `oxfmtLoadsSvelte(root)`: `createRequire(<oxfmt's entry>).resolve('svelte/compiler')`, lazily, at most once
  per call, only when a `.svelte` block would be sent. `MODULE_NOT_FOUND` → that block is not sent, stays as written,
  the result says `missingSvelte: true`; other blocks are still formatted. Any other error (svelte found but broken)
  is thrown: its own message says why (exit 2).
- `FormattedUcf` (`src/types.ts:170`) gains `missingSvelte: boolean`, `false` on every other path (splitter errors too).
- Svelte parse errors take the 7.6 path unchanged: no label, no `(line:col)` → `format-error` on the `<svelte>` opening
  tag, message `<svelte> does not parse: <Svelte's first line>`, file unchanged.

### 4. `mf-fmt` (`run`, `format/index.ts:100`)

Any file's result has `missingSvelte` → one finding after the loop, no file:
`{code: 'missing-svelte', severity: 'warning', message: 'oxfmt cannot load svelte/compiler, so <svelte> blocks stay as written; add svelte to devDependencies'}`.
Readable: `warning missing-svelte: …` then the summary; JSON `warningCount: 1`; exit stays 0. Summary, JSON data and
`--check` unchanged: a skipped block is never `unformatted`.

### 5. Fixture `packages/e2e/fixtures/apps/lint-format-svelte/` (new)

- `.oxfmtrc.json`: `{"svelte": true}` with a one-line comment.
- `Messy.ucf`: a byte copy of `lint-format/Messy.ucf` (a test pins they are equal).
- `svelte.ts` importing `./Messy.ucf` `with { framework: 'svelte' }`; `vite.config.ts` with `svelte()` and `multifront()`.
- No `.editorconfig`: the repo root's applies to the CLI and to `mf-fmt` alike.

### 6. Shared helpers (`packages/e2e/editor/lib/format.ts`)

- `LINT_FORMAT_SVELTE`.
- `ORIGINAL`, `copyMessy` and `expectCliOutput(root, file, newline, sent = SENT)` move here from `mf-fmt.spec.ts`;
  `SENT_WITH_SVELTE` adds `svelte: '.svelte'` to `SENT`.
- `copyOxfmtWithoutSvelte(dir)`: every entry of oxfmt's pnpm `node_modules` folder (oxfmt, tinypool, its native
  `@oxfmt/binding-*`) but `svelte`, into `dir/node_modules`, symlinks dereferenced: a real oxfmt install that cannot
  see svelte.

### 7. Docs

- Spec 6.1 "Formatting": oxfmt formats TSX, Vue SFC code, CSS / SCSS / Less, and Svelte when the project's oxfmt config
  turns its `svelte` option on (oxfmt then needs `svelte` installed; without it `<svelte>` blocks stay as written and
  `mf-fmt` warns); with the option off they stay as written.
- `docs/architecture.md:111` (`mf-fmt` bullet): one sentence on the `svelte` option and the warning.
- Milestone: 7.7 Build names `missing-svelte` and `missingSvelte`; the "New codes" bullet adds `missing-svelte` (7.7);
  the `mf-fmt` paragraph and "Hands to later milestones" say `formatUcf` returns `{text, findings, missingSvelte}`;
  7.10 Build logs one line on `missingSvelte`; open question 1 settled; `- Status: done`.
- No `publicdocs/` page describes `mf-fmt` yet.

## Tests

Area Editor, `packages/e2e/editor/format/svelte.spec.ts`; real `mf-fmt`, the real oxfmt CLI, a real Vite build. Runs
on this host and in the CI `check` job (`pnpm devx test`, e2e project); nothing CI lacks (oxfmt, svelte and the Svelte
Vite plugin are root devDependencies).

1. `lint-format-svelte/Messy.ucf` equals `lint-format/Messy.ucf` byte for byte.
2. Temp copy: exit 0, `mf-fmt: formatted 1 of 1 files`; every block, `<svelte>` included, equals the oxfmt CLI output
   (`--stdin-filepath Messy.ucf.svelte.svelte` etc., same folder), flush left; text outside the blocks unchanged.
3. A second run changes nothing; `--check` exits 0.
4. The real Svelte build (`buildApp`, input `svelte.ts`) of the formatted copy succeeds, with the `svelte` entry.
5. The object form `"svelte": {}` turns it on too, matching the CLI.
6. Per block file: `nested/Messy.ucf` and an override `{"files": ["nested/*.svelte"], "options": {"svelte": false}}`:
   the nested `<svelte>` block stays as written, the top one is formatted.
7. A `<svelte>` markup edit that does not parse (`{#if}`): exit 1, one `format-error` on the `<svelte>` opening tag,
   `<svelte> does not parse: expected_whitespace: Expected whitespace`, file unchanged.
8. No svelte for oxfmt: `copyAppOutside` + `copyOxfmtWithoutSvelte`, `assertNotInstalled(root, 'svelte')`, `NODE_PATH`
   unset, `Messy.ucf` and `nested/Messy.ucf`:
   - `--check --format json`: the warning first (no file), then both `unformatted` findings;
   - write mode: exit 0, stdout exactly `warning missing-svelte: …` and `mf-fmt: formatted 2 of 2 files` (one warning
     for two files), both `<svelte>` blocks as written, the other blocks formatted;
   - `--format json` again: exactly that one finding, `warningCount: 1`;
   - a `<react>` block that does not parse beside it: the warning and the `format-error`, exit 1;
   - a `.ucf` file with no `<svelte>` block: no warning.
9. 7.6's `mf-fmt.spec.ts` stays green, its cases unchanged (only its helpers move to `editor/lib/format.ts`):
   `lint-format/`, without the option, keeps `<svelte>` as written.

## Fuzzing

None: the milestone puts no fuzz test in 7.7 (decision 4).

## Out of scope

- Exact positions for Svelte parse errors (on the opening tag, as 7.6 does for any position-less error).
- oxfmt's silence on `<script>` syntax errors inside Svelte and Vue blocks and its stderr stack (the CLI does the same):
  filed as its own guidelines todo in this PR, found here.
- The server side (7.10).

## Done when

- `svelte.spec.ts` and `mf-fmt.spec.ts` green; `pnpm devx check` passes.
- Spec 6.1, architecture.md and the milestone doc match what shipped; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
