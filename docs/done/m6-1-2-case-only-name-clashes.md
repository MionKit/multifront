---
type: fix
spec: full-plan
status: done
created: 2026-10-14
milestone: 6.1
step: 6.1.2
---

# Library output names that differ only by case are a build error

## Problem

`buildLibrary()` checks output names with exact, case-sensitive string compares. On macOS and Windows the file
system ignores case, so two names that differ only by case are one file there: whichever is written or unpacked last
wins. Checked on `main` today, on a copy of the fixture library (Linux):

- `src/badge.ts` beside `src/Badge.ucf`, both exported: builds green. Rolldown silently renames the module
  `badge2.js` (it dedupes names ignoring case after our `fileName` hook has run).
- `src/plain.svelte` beside `src/Plain.ucf` (svelte): builds green, ships both `Plain.svelte` and `plain.svelte`.
- `src/icon.svelte.ts` beside `src/Icon.ucf` (svelte, types on): builds green, ships both `Icon.svelte.d.ts` and
  `icon.svelte.d.ts`.

Two related gaps found while checking (same kind of name check):

- `src/Icon.svelte.js` (a JS runes module) beside `Icon.ucf` with types on fails only through tsc's `TS5056 Cannot
  write file … Icon.svelte.d.ts because it would be overwritten by multiple input files`. The case-only
  `icon.svelte.js` builds green: the types check only looks for `<name>.svelte.ts`.
- Reserved names, exact match only: `src/Styles.ucf` gives `Styles.css` beside `styles.css` (`css.ts:42-44`), and
  `src/_ucf/scopeattrs.ts` ships `_ucf/scopeattrs.js` beside the scope helper `_ucf/scopeAttrs.js`
  (`source.ts:184-186`). Both build green on Linux.

## Plan

All in `packages/vite/src/library/`.

1. `names.ts`: two shared helpers.
   - `fileKey(name)` → `name.toLowerCase()`: names with one key are one file on macOS and Windows.
   - `clashMessage(first, firstName, second, secondName)`: equal names →
     `buildLibrary: <first> and <second> would both be written as <firstName>` (unchanged text); case-only →
     `buildLibrary: <first> and <second> would be written as <firstName> and <secondName>, which macOS and Windows see as one file`.
2. `build.ts` (`buildOne`, the chunk `fileName` hook): `owners` keyed by `fileKey(name)`, value `{id, name}`. On a
   clash the two `[shownFile, name]` pairs are sorted by shown path, then `clashMessage(...)` is thrown. Sorting fixes
   the order (the old test accepted either).
3. `source.ts` (`librarySource`, `generateBundle`): `written` keyed by `fileKey(fileName)`, value `{fileName, file}`.
   A plain file whose key is taken fails with `clashMessage`, component first.
4. `dts.ts` (`emitSvelteTypes`): an index `fileKey(stagedPath) → stagedPath` over the staged files. Each staged
   `.svelte` root `file` looks up `${file}.ts`, then `${file}.js`; a hit fails with `clashMessage` on
   `${file}.d.ts` and the module's `.d.ts` name. Covers `.svelte.ts` and `.svelte.js`, any case.
5. Reserved names, any case:
   - `css.ts`: `fileKey(cssName(file, src)) === fileKey(STYLES)`. Exact: today's message. Case-only:
     `buildLibrary: src/Styles.ucf would be written as Styles.css, which macOS and Windows see as styles.css, the combined CSS file`.
   - `source.ts`: a bundle key with `fileKey(key) === fileKey(LIBRARY_SCOPE_HELPER)`. Exact: today's message.
     Case-only: `buildLibrary: _ucf/scopeattrs.js, which macOS and Windows see as _ucf/scopeAttrs.js, is the name of the shipped scope helper; rename that file in src`.

Commits: `docs(todos)`; `fix(vite)` case-insensitive pair checks (1 to 4, `.ts` modules); `fix(vite)` `.svelte.js`
modules in the types check; `fix(vite)` reserved names ignoring case; normalization todo; docs; review fixes;
`chore(comments)`.

## Decisions

- A case-only clash gets its own message, `<a> and <b> would be written as <x> and <y>, which macOS and Windows see as
  one file`: it shows both names, so the case difference and the Linux-green build make sense.
- The `.svelte.js` types check and the `styles.css` / `_ucf/scopeAttrs.js` reserved names are fixed here, each its
  own commit and test (AGENTS.md: a related issue is fixed in the same PR).
- Unicode normalization clashes (NFC vs NFD) are not fixed here: filed as a guidelines todo in this PR. The step is
  about case only, and the cross-OS wording does not hold for normalization on Windows.

## Tests

Build area, real `buildLibrary()` on `withEditedLibrary()` fixture copies. This host and CI's `check` job
(`pnpm devx test`), plus the floor jobs. No new infra. Every fixture keeps file names distinct ignoring case (the
extensions differ), so the copies work on a case-insensitive host too.

- `packages/e2e/build/library.spec.ts`: `src/badge.ts` exported from `index.ts` → the case-only message
  for `src/Badge.ucf` / `src/badge.ts`, `Badge.js` / `badge.js`. The existing exact test asserts the exact message
  `buildLibrary: src/Badge.ts and src/Badge.ucf would both be written as Badge.js`.
- `packages/e2e/build/svelte-library.spec.ts`:
  - `src/plain.svelte` beside `src/Plain.ucf`, rendered by Card → the case-only message, `Plain.svelte` /
    `plain.svelte`.
  - `it.each` over `src/icon.svelte.ts`, `src/icon.svelte.js` (case-only) and `src/Icon.svelte.js` (exact), each
    exported from `index.ts`, types on → each exact message.
  - `src/_ucf/scopeattrs.ts` imported by Card → the case-only helper message.
- `packages/e2e/build/library-css.spec.ts`: `src/Styles.ucf` → the case-only styles message.

## Docs

- `docs/milestones/m6-library-build.md`: 6.1 build errors, 6.2 `styles.css` error, 6.8 plain file and `.d.ts`
  clashes.
- `publicdocs/06-building-a-library.md`, "Fixing a Failed Build": a row for the case-only message; the `styles.ucf`
  row names the case-only form.
- `docs/milestones/m6.1-before-full-editor.md` step 6.1.2: Build text records the decisions; `- Status: done`.
- `docs/spec.md`, `docs/architecture.md`: none, neither lists library build errors. `docs/plan.md` 6.1 already says it.

## Fuzzing

Not a candidate: the rule is one string compare. Fixture copies pin each check.

## Out of scope

- Unicode normalization clashes (own todo).
- Hand-written `.d.ts` files in `src` against generated declarations.
- `mf-build` output format (6.1.5).
- The Windows CI job: the check is a string compare, not file system behaviour.

## Done when

- Every case-only clash above fails its build with its exact message on any OS; exact clashes keep today's messages
  (the exact `.svelte.js` one now gets ours instead of TS5056).
- The new tests pass in `pnpm devx check`.
- m6 doc, public docs table and the m6.1 step text match what shipped; the step has `- Status: done`.
- The todo is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
