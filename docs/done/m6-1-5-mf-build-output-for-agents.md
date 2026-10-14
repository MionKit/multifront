---
type: feature
spec: full-plan
status: done
created: 2026-10-14
milestone: 6.1
step: 6.1.5
---

# `mf-build` output and exit codes for agents

## Problem

`mf-build` (`packages/vite/src/library/cli.ts`) is written for a human at a terminal:

- Exit code 1 for everything: a broken `.ucf` file, a typo in a flag and a bad config look the same.
- On failure stderr holds Vite's `✗ Build failed in 518ms`, Rolldown's `Build failed with 2 errors:` with stack
  traces, and our `file:line:col` with a 0-based column. Only the first diagnostic of a file has a structured `loc`
  (`rollupError()`, `packages/vite/src/diagnostics.ts:14`). Library errors (name clash, non-peer import, ...) have no
  code; type errors are one text blob (`compileError()`, `packages/vite/src/library/dts.ts:179`).
- No `--help`; an unknown option prints node's `Unknown option '--outdir'. To specify a positional ...`.
- No machine format. Success prints one line per framework.

What agents get from other tools today (run on this host on a broken file):

- `tsc` / `vue-tsc --pretty false`: `bad.ts(1,7): error TS2322: ...`, 1-based line and column, no end, no JSON.
  Exit 2 with errors under noEmit, 1 on bad usage: the codes cannot be told apart.
- `svelte-check --output machine`: `ERROR "bad.ts" 1:7 "..."`; `machine-verbose`: one JSON object per line
  `{type, filename, start:{line,character}, end, message, code}`, 0-based. Exit 1 on errors.
- `oxlint -f json`: one document, `{diagnostics:[{message, code, severity, url, help, filename,
  labels:[{span:{offset,length,line,column}}]}], number_of_files, ...}`, 1-based line and column. Exit 1 on errors.

So: one JSON document on stdout (like oxlint), 1-based line and column (what tsc and oxlint print, and what
`file:line:col` links in editors expect), an end position (like svelte-check), and exit codes that keep "your files
are wrong" apart from "the command could not run".

## Decisions

Answers from the run-milestone orchestrator:

1. Exit 2 under `--format json`: one plain line on stderr, empty stdout, as `vue-tsc` / `tsc` print usage errors
   whatever the output mode, and an unknown option is found before `--format` is read. Spec 8.1 says so.
2. The five library codes (`name-clash`, `not-a-peer`, `outside-src`, `css-outside-style`, `svelte-import`) join
   core's `DiagnosticCode` union ("One code per error" in `docs/milestones/README.md`); checked: no near-duplicate
   there. `Finding.code` stays `string`: tsc (`TS2322`) and plugin codes (`vite:vue`) are not ours.
3. No fuzz test: the core spec runs the position round trip over every invalid fixture, and `findingOf` reuses the
   splitter's offsets, which its own fuzz covers.
4. The exit test changes: its mf-build output check moves to the new summary line; the milestone's Exit test line
   says so.

## Plan

### 1. The shared shape and command runner: `packages/core/src/command.ts` (new)

Core, because `@multifront/vite` and `@multifront/language-tools` both depend on it. Only `node:util` / `node:path`.

Types in `packages/core/src/types.ts`, exported from the index:

```ts
/** One problem as a command reports it; line and column 1-based, always in the file the user wrote. */
export interface Finding extends Pick<Diagnostic, 'severity' | 'message'> {
  file?: string; // absolute; printers show it relative to the cwd, '/' separators
  line?: number;
  column?: number;
  end?: {line: number; column: number}; // just past the last character
  code: string;
  block?: BlockTag;
  framework?: Target;
}
export interface CommandOption extends Pick<ParseArgsOptionDescriptor, 'type' | 'multiple'> {value?: string; description: string}
export interface CommandSpec {name: string; summary: string[]; options: Record<string, CommandOption>; example: string}
export type CommandValues = Record<string, string | boolean | (string | boolean)[] | undefined>;
export interface CommandResult {findings: Finding[]; summary: string; data?: Record<string, unknown>}
```

`DiagnosticCode` gains `LibraryErrorCode` = `'name-clash' | 'not-a-peer' | 'outside-src' | 'css-outside-style' |
'svelte-import'`, also exported. `CommandOption` stays internal to core.

Functions, exported from `@multifront/core`:

- `findingOf(diagnostic, split): Finding`: `line`, `column + 1`, `end` from `locate(source, diagnostic.end)` (column
  + 1), `block` = type of the block whose `[start, end)` holds `diagnostic.start` (none outside every block).
- `runCommand(spec, args, run): Promise<number>`, the exit code, never `process.exit`:
  1. Adds `--format <format>` (`text` | `json`, default `text`) and `-h, --help` to every spec.
  2. `node:util` `parseArgs`, strict, no positionals. On failure one line on stderr, exit 2:
     - unknown option (through `tokens: true`): `mf-build: unknown option '--outdir'; use --root, --framework,
       --out-dir, --no-dts, --format or --help` (`orList`)
     - a positional: `mf-build: unexpected argument 'src'; mf-build takes options only`
     - a bad format: `mf-build: unknown format 'xml'; use text or json`
     - a missing value / a value on a boolean: `mf-build: ` + node's message
  3. `--help`: the help on stdout, exit 0.
  4. `run(values)`; a throw means nothing reached the files: `mf-build: <message>` on stderr, exit 2.
  5. Findings sorted by file, line, column, code (Rolldown reports in no fixed order).
  6. `text`: one line per finding on stdout, then `mf-build: <summary>`. `json`: one pretty-printed document on
     stdout, nothing else.
  7. Exit 1 if any finding is an error, else 0.
- Readable line: `<file>:<line>:<column>: <severity> <code>[ (<framework>)]: <message>`; no position: `<file>: ...`;
  no file: `<severity> <code>: ...`.
- JSON: `{"findings": [...], "errorCount": n, "warningCount": n, ...data}`; keys in `Finding` order, absent ones
  left out, `file` relative to the cwd.
- Help, built from the spec:

  ```
  Usage: mf-build [options]

  Builds the .ucf components of a library into one package per framework.
  Reads multifront.config.ts (or .js, .mjs) in the root; options win over it.

  Options:
    --root <folder>      the library folder (default: the current folder)
    --framework <name>   build only this framework: vue, react or svelte; repeat for more
    --out-dir <folder>   where the packages go, relative to the root (default: dist)
    --no-dts             write no .d.ts files
    --format <format>    text or json (default: text)
    -h, --help           show this help

  Example:
    mf-build --framework react --format json

  Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
  ```

Exit codes, the rule for every command: 0 clean; 1 findings (something in the user's files); 2 the command could not
run (bad usage, bad config, a missing tool). For mf-build: a failure inside one framework's build (Vite build, types,
`package.json`) is findings; option and config checks before the builds, and any other error, are exit 2.

### 2. Build errors become findings (`packages/vite`)

- `src/diagnostics.ts`:
  - `rollupError(diagnostics, split)` also sets `meta: {findings: diagnostics.map((d) => findingOf(d, split))}`.
    Rolldown keeps `meta` on each error of a `BundleError` (checked). `message` unchanged. No `pluginCode`: Vite
    fills it with the module's source code, so nothing reads it.
  - New `findingError(message, finding)`: `{message, meta: {findings: [finding]}}`, and `importFinding(importer,
    code, message)`: the file as `file`, the importer's block (the one holding an import) as `block`.
  - `plugin.ts:52` and `:200` pass their `split`; `plugin.ts:158` (`resolveTarget` errors) and `:163`
    (`missing-target-block`) use `findingError` with `importFinding`, the importer as `file`. Messages: `resolveTarget`
    errors become `<specifier>: <message>` (no absolute importer path); `missing-target-block` keeps
    `missingTargetBlockMessage()`, which already names both files.
  - `attributes.ts` (an import attribute error, positioned in the importer): the error gets `meta.code` and
    `meta.message`, the short `<specifier>: <message>` a finding prints; the foreign path below reads both.
- `src/library/errors.ts` (new):
  - `class LibraryError extends Error {findings: Finding[]}`, its `message` the exact text thrown today.
  - `libraryError(code, file, message)` / `libraryRollupError(...)`, both through `importFinding({fileName: file})`.
  - `buildFindings(err)`: a `BundleError`'s sub-errors → their `meta.findings`, or our thrown `LibraryError`'s
    `findings`, or one finding from a foreign error (`foreignFinding()`):
    - `file` = `fileOf(loc.file ?? id)`; none when neither is set.
    - Position only when `loc.file` is set and names a real file (absolute, no query, not a virtual id). plugin-vue
      sets `loc.file` only on its compiler errors (template, SFC parse), whose positions are in the file; a Vue
      `<script>` (babel) error has a `loc` relative to the script alone and no `loc.file`, so it gets no position.
    - Column + 1, except plugin-vue whose `loc.column` is already 1-based (`vue-sourcemaps.spec.ts:200`).
    - `code` = `meta.code`, else the plugin name (`vite:vue`, `vite:css`), else the `[name]` a Rolldown builtin
      plugin starts its message with (`builtin:vite-transform`), else Rolldown's `code`.
    - `message` = `meta.message`, else the first line without terminal colors (and without that `[name] ` tag).
    - `block` = `style` for a style query, else the block the module id names (`importerFromId(id).block`).
- Library throw sites keep their messages and add findings (`file` absolute; a clash names the first of its two
  files, sorted). `clashMessage()` returns the bare text; `libraryError()` / `libraryRollupError()` add the
  `buildLibrary: ` prefix, so `not-a-peer` and `outside-src` now carry it too:
  - `name-clash`: `build.ts:144`, `css.ts:46`, `source.ts:178`, `source.ts:188`, `dts.ts:317`.
  - `not-a-peer`: `build.ts:95` (the importer). `outside-src`: `build.ts:106`. `css-outside-style`: `css.ts:59`.
    `svelte-import`: `source.ts:156`.
  - Hooks call `this.error(findingError(...))`; the two plain throws (`build.ts:144`, `dts.ts:317`) throw
    `LibraryError`.
- `dts.ts` `compileError()` → `LibraryError`: each tsc line
  `/^(?:(.+?)(?:\((\d+),(\d+)\))?: )?(error|warning) (TS\d+): (.*)$/` is one finding, code `TS2322`... A `.ucf` file
  gets no position (generated code, today's rule); a plain file keeps tsc's 1-based line and column; a path that is
  not a staged source (a broken library `tsconfig.json`) gives a finding with no file. Any other line (tsc's indented
  follow-ups) joins the previous finding's message with a space. Message `buildLibrary: the react types do not
  compile:\n...` unchanged.
- `build.ts` `buildLibrary`: the per-framework loop catches what `buildOne` throws. A `LibraryError` or any error
  with an `errors` array → rethrown as `LibraryError` (same message, `cause` = original), every finding with
  `framework` = that build's target (`frameworkError()`); one with no finding read from it becomes a plain error.
  Anything else rethrown as is: the config errors (`build.ts:65`, `75`, `193`,
  `198`, `201`, `207`, `209`) and the missing types tool (`dts.ts:54`) stay plain, so exit 2. `LibraryError` is not
  in the package index.

### 3. `mf-build` on `runCommand` (`packages/vite/src/library/cli.ts`)

- `runMfBuild(args)` = `runCommand(MF_BUILD, args, run)`. `run`:
  - loads the config as today (a load failure throws: exit 2, `mf-build: cannot load <file>: <message>`), merges
    the options as today;
  - passes `vite.customLogger`: the config's own `vite.customLogger`, else Vite's
    `createLogger(config.vite?.logLevel ?? 'warn')`, wrapped (through its prototype) so only the
    `✗ Build failed in ...` line goes; every other log, `Unable to resolve @import ...` say, stays on stderr;
  - returns `{findings: [], summary, data: {packages}}`; on a `LibraryError` its findings and
    `2 errors in the react build`; any other error goes on to `runCommand` (exit 2).
- Success summary, one line: `mf-build: built 3 packages in dist: vue 66 files, react 49 files (skipped VueOnly.ucf),
  svelte 31 files (skipped Badge.ucf, VueOnly.ucf)`. The folder is the common out dir relative to the cwd (`.` when
  equal); `1 package` singular.
- JSON `packages`: `[{framework, name, outDir, files, skipped}]`, `outDir` relative to the cwd, `files` a count;
  `[]` on failure.

### 4. Consumer specs that read mf-build's output

- `packages/e2e/consumer/exit.spec.ts` "builds every framework with the real mf-build bin": its three
  `/^vue: \d+ files .../m` checks become one check of the new summary line. Its failure message and
  `consumer/sveltekit-plain-svelte.spec.ts:72` print `stdout` too.

## Tests

All in `pnpm devx test` (CI `check` job); `library-cli.spec.ts` also in the `windows` job, so expected paths use `/`.
No new infra: real `vite build`, real tsc / vue-tsc, a child `node` on the bin through `runMfBuild()`
(`packages/e2e/build/lib/library.ts:179`).

Rewritten `packages/e2e/build/library-cli.spec.ts`, real `mf-build` bin on fixture library copies:

1. Clean, readable: exit 0, stderr `''`, stdout exactly the summary line (counts from disk).
2. Clean, `--format json`: `{findings: [], errorCount: 0, warningCount: 0, packages: [...]}` with the config's
   three names, `dist/<framework>`, counts, skipped lists.
3. "Flags win over the config" and "no config", on the summary line and JSON `packages`; the `.` case from `dist/`.
4. Clash copy (`src/card.ts` beside `src/Card.ucf`, re-exported from `src/index.ts`, `--framework vue --no-dts`):
   exit 1, stderr `''`; readable stdout exactly `src/Card.ucf: error name-clash (vue): src/Card.ucf and src/card.ts
   would be written as Card.js and card.js, which macOS and Windows see as one file` then
   `mf-build: 1 error in the vue build`; JSON: that finding, `errorCount: 1`, `packages: []`.
5. `.ucf` positions: `src/Twice.ucf` = `fixtures/components/invalid/DuplicateReact.ucf` (`--framework react
   --no-dts --format json`): two `duplicate-target` findings whose line/column to end span exactly the core
   diagnostic's text, `block: 'react'`, `framework: 'react'`; the readable run gives the same two lines.
6. `it.each`, one row per other path, edits from the existing library specs, `--format json`, exit 1, finding exact:
   `not-a-peer` (`left-pad` in `utils/cx.ts`), `outside-src` (`../shared/tokens.js`), `css-outside-style`
   (`cx.css`), `name-clash` (`src/Styles.ucf`; a plain Svelte case clash; `src/_ucf/scopeattrs.ts`; `icon.svelte.ts`
   beside `Icon.ucf`), `svelte-import` (a `~/` alias import in Card's `<svelte>` block, the alias set in
   `multifront.config.ts`), `missing-target-block` (a `<react>` component importing `./VueOnly.ucf`, importer as `file`),
   `target-not-enabled` (`with {framework: 'vue'}` in `utils/cx.ts` in the react build, at the specifier),
   `vite:vue` (`vue/TemplateError.ucf` in `src`: position at `<span>`, 1-based, `block: 'vue'`), a Vue `<script>`
   error (a non-literal attribute: `vite:vue`, no position), a Rolldown builtin error naming no module (the same in
   `utils/cx.ts`: `builtin:vite-transform`, no file), `TS2322` in `src/Card.ucf` (no position) and in
   `src/utils/cx.ts` (tsc's position), `framework: 'react'`.
7. An unresolved `@import` in Icon's `<style>`: Vite's `Unable to resolve` log stays on stderr, `Build failed` does
   not; the finding is `vite:css`, `block: 'style'`.
8. A library `tsconfig.json` with `types: ["nonexistent"]`: readable stdout exactly `error TS2688 (react): ...`, no
   file, tsc's follow-up lines joined.
9. Exit 2, stdout `''`, stderr one exact line, no `dist`: `--outdir x` and `-x` (names every option), `src`,
   `--format xml`, `--root` with no value, `--no-dts=yes`, the five config cases, `--framework angular`; one of them
   with `--format json`.
10. `--help` and `-h`: exit 0, stdout exactly the help, stderr `''`.

`packages/e2e/build/library.spec.ts` pins the `buildLibrary: ` prefix `not-a-peer` and `outside-src` now carry.
Both new specs read positions with `locate` / `offsetAt` of `packages/e2e/editor/lib/tsserver.ts`.

Not covered, as no `mf-build` path reaches them today: a finding with severity `warning` (exit 0 on warnings only;
the first warning comes with M7's `mf-lint`), `importFinding` with no importer (a library entry always has the
block it is built for), a failed framework build with no finding read from it (exit 2), and the first branch of
`attributes.ts` `importError` (`framework-attribute-not-literal`: Vite's transform and Vue's compiler reject a
non-literal attribute first, tests 6 above; app builds keep its test in `build/imports.spec.ts`).

New `packages/core/test/command.spec.ts`: every `fixtures/components/invalid/*.ucf` through `splitBlocks` +
`checkBlocks` + `findingOf`; each finding's line/column maps back to `start`, its end to `end` (offsets recomputed
from the text), `block` is the block holding `start` or none.

`packages/e2e/build/built-packages.spec.ts` unchanged (checks `stderr` and the code of the dist bin).

## Docs

- `docs/spec.md`: new "8.1 Command rules" for every multifront command: readable default, `--format json`, the
  `Finding` fields, 1-based positions always in the file the user wrote, exit codes 0 / 1 / 2 (stdout empty on 2),
  `--help`, the unknown-option message. Section 8's `mf-build` line points to it.
- `docs/plan.md`: the 6.1 bullet names what shipped; the 6 bullet's "Exit code 1 on any error" → the command rules.
- `docs/architecture.md`: "Where the code lives" names `packages/core/src/command.ts`; library paragraph: `mf-build`
  runs through `runCommand`, `buildLibrary` throws a `LibraryError` with findings. No graphic change.
- `publicdocs/06-building-a-library.md`: "Running the Build" (summary line, `--format json`, exit codes, `--help`);
  "Fixing a Failed Build" (every finding printed, a Code column).
- `publicdocs/07-errors.md`: the library note says they have codes, listed on 06.
- Milestone doc: 6.1.5 shipped names and `- Status: done`, "Hands to later milestones" with exact names, the Exit
  test line ("unchanged except for the dropped Svelte skip and the mf-build summary check").

## Out of scope

- One-file or folder checks (`mf-build` builds a library). `runCommand` takes no positionals yet; the first M7
  command with paths adds them, with its test.
- Vite and Rolldown warnings as `warning` findings: they stay Vite's lines on stderr.
- Positions for type errors inside a `.ucf` file (M7's `mf-tsc`).
- Building the other frameworks after one fails: the run stops at the first failing framework, with all its findings.

## Done when

- `mf-build`: one summary line when clean, `--format json`, exit 0 / 1 / 2, `--help`, unknown option names the
  real ones.
- Every test above passes from the repo root; `pnpm devx check` is green.
- Docs updated as listed, milestone step marked done, this spec in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
