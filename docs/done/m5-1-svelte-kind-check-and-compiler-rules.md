---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.1
---

# Milestone 5.1: the `<svelte>` kind, `check` and the compiler rules

## Problem

`svelteKind` (`packages/core/src/blocks/svelte.ts:1-14`) already has its registry row (`role: 'target'`, `source.svelte`)
and a compiler-free `check`: M1's `style-inside-target` scan, where every non-void element nests, so a `<style>` in
`<svelte:head>` is already allowed (`invalid/StyleInSvelte.ucf`, `check.spec.ts`). Missing:

- `loadSvelteCompiler(root)` in core; svelte is not installed in the repo.
- The two rules that need the Svelte compiler, `svelte-parse-error` and `missing-style-module`. "Core checks never
  load a compiler" (milestones README), so they run in `build()`, which needs the project root: `BuildContext`
  (`types.ts:129`) has no `root`, only `relativePath`.
- `svelteKind` has no `build`, so `buildTarget` (`blocks/index.ts:31-35`) throws `target-not-built` for any svelte pick
  before Svelte ever reads the block.

Checked on svelte 5.57.0 (installed in a scratch folder):

- `require('svelte/compiler')` works from CJS (`compiler/index.js`).
- `parse(content, {modern: true})` throws a `CompileError` with `code`, `position: [start, end]` (offsets into
  `content`) and `message` = `"<text>\nhttps://svelte.dev/e/<code>"`. `{title` in markup gives `js_parse_error`
  "Unterminated regular expression", zero-width.
- AST node `start`/`end` are offsets into `content`, in `instance`, `module` and `fragment` alike (TS scripts too).
  Every `$x` use (script, attribute, `{#each}`, `class:`, `bind:`, spread, `{#snippet}`, `<svelte:head>`) is an
  `Identifier` node; object keys and `.prop` member names are `Identifier`s too, so the walk skips them.
- `compile` reports an undeclared `$classes` as `global_reference_invalid`; a `$count` with a top-level `count` is a
  store subscription.
- Every existing fixture's `<svelte>` block parses (`Card`, `Button`, `GrammarEdges`, `AllBlocks`,
  `ReactDefaultSpecifier`, `StyleInSvelte`) and none uses a `$name` without its module.

## Plan

### 1. Dependencies

- Root `package.json` devDependencies: `"svelte": "5.57.0"` (released 2026-08-28, past the 30-day rule). Fixture apps
  under `packages/e2e/.tmp` resolve it from the repo root.
- `packages/core/package.json`: peer `"svelte": "^5.0.0"`, `peerDependenciesMeta.svelte.optional: true`, devDependency
  `"svelte": "5.57.0"` (the packages/AGENTS.md exception, as for `@vue/compiler-sfc`). Lockfile via `pnpm add`.

### 2. `loadSvelteCompiler(root)`: new `packages/core/src/svelteCompiler.ts`

- Mirrors `vueCompiler.ts`: `require.resolve('svelte/compiler', {paths: [root]})` then `require(path)`.
  Not found → `multifront: could not find svelte. Install svelte in your project.` Found but broken → its own error.
- `types.ts`: `export type SvelteCompiler = Pick<typeof SvelteCompilerModule, 'parse'>`.
- `index.ts` exports `loadSvelteCompiler` and the type `SvelteCompiler`.

### 3. `BuildContext.root`

`types.ts`: `root: string` (the Vite root: target builds load the project's compilers from it); `context.ts` fills it
from `options.root`.

### 4. The compiler rules: `svelteKind.build` in `blocks/svelte.ts`

`build(block, ctx)`:

1. `loadSvelteCompiler(ctx.root).parse(block.content, {modern: true})`.
2. A thrown error with a `code` and a `position` → one `svelte-parse-error` at `contentStart + position`, message
   `<svelte> does not parse: <first line of Svelte's message>`. Any other throw is rethrown.
3. Else `missing-style-module`, one per use, range = the identifier:
   - walk `instance`, `module`, `fragment`; `Identifier` nodes named `$x` (x not empty, not starting with `$`); skip
     non-computed `key`s (object, class, TS members) and non-computed member `property`; skip runes (`state`,
     `derived`, `effect`, `props`, `bindable`, `inspect`, `host`);
   - `$style` → needs `ctx.modules.$style`, message `<svelte> uses $style, but no <style module> exists; add one`.
     Always ours, even beside a `style` prop (milestone Risks);
   - `$x` (x ≠ style) → ours when `ctx.modules[x]` exists; else, when `x` is bound at the top level of the instance or
     module script (import local, `let`/`const`/`var` pattern name, function or class name, also under `export`), it
     is a store: skipped; else `<svelte> uses $x, but no <style module="x"> or store named x exists`.
   - sorted by `start`.
4. Errors → `throw new DiagnosticsError(errors)`. Clean → throw `target-not-built` (today's message and range); 5.2
   replaces that throw with the `.svelte` file.

- `diagnostics.ts`: `targetNotBuilt(split, block)` helper, used by `buildTarget` and svelte's `build`.
- `types.ts`: `DiagnosticCode` gains `'svelte-parse-error' | 'missing-style-module'`; the `build?` comment says style,
  react, vue and svelte.
- `check` unchanged, compiler free. `checkBlocks` reports `style-inside-target`; `buildTarget(split, ctx, 'svelte')`
  (Vite's `load`) reports it first, then the compiler rules, then `target-not-built`. No Vite change.

### 5. Fixtures: `packages/e2e/fixtures/components/svelte/errors/`

- `TopLevelStyle.ucf`: a `<style>` at the top level of the block (plus a root `<style>`) → `style-inside-target`.
- `StyleInHead.ucf`: `<svelte:head><style>…</style></svelte:head>` → nothing.
- `UnclosedBrace.ucf`: `<script lang="ts">` with `$props()`, `<h2>{title</h2>` → `svelte-parse-error`.
- `StyleWithoutModule.ucf`: only `<style scoped>`, `$style.card` in script and markup → two `missing-style-module`.
- `WrongModuleName.ucf`: `<style module="classes">`; `$classes.title` fine; `$style.card` and `$theme.accent` each a
  `missing-style-module`.
- `NamedModule.ucf`: `<style module>` + `<style module="classes">`, `$style` and `$classes` uses, `let {style} =
  $props()`, `$state`, `$derived`, a store `const count = writable(0)` with `{$count}`, `{$theme: 1}` and `o.$theme`
  → nothing.

## Tests

All in `pnpm devx test`, on this host and in CI's `check` job; they need only the root `svelte` devDependency.

- `packages/core/test/blocks/svelte.spec.ts` (new), on `react.spec.ts`'s pattern:
  - a row per `svelte/errors/` fixture ("has a row for every fixture"), hand-written `{code, line, column, text}` of
    what `buildTarget(split, ctx, 'svelte')` throws, `target-not-built` left out (`ctx` from `createBuildContext`,
    root `FIXTURES_DIR`);
  - `checkBlocks(split)` gives only the compiler-free `style-inside-target`;
  - every diagnostic: line/column match its start offset, range inside the block content, message starts `<svelte>`,
    one line, no URL; `missing-style-module` text is exactly `$style` / `$theme`, its two messages pinned;
  - valid fixtures (`StyleInHead`, `NamedModule`) throw only `target-not-built`;
  - a JSON snapshot per fixture (`__snapshots__/svelte/errors/<name>.json`);
  - sweep: every other fixture with a `<svelte>` block (`Card`, `Button`, `editor/GrammarEdges`, `react/AllBlocks`,
    `ReactDefaultSpecifier`) throws only `target-not-built`.
- `packages/core/test/svelteCompiler.spec.ts` + `svelteCompiler.child.ts` (new), mirroring the Vue pair: the repo root
  resolves the same module as `createRequire(<repo>/package.json)('svelte/compiler')`; a temp folder with no svelte
  gets the "could not find" message (child process, no `NODE_PATH`); a broken `node_modules/svelte` passes its own
  error on.
- Unchanged and green: `blocks/index.spec.ts` "throws target-not-built for svelte", `e2e/build/react-target.spec.ts`
  svelte pick.

## Docs

- `docs/milestones/m5-svelte-target.md`: 5.1 text to what shipped (`BuildContext.root`, `build` ending in
  `target-not-built`, fixture names, store rule), `- Status: done`; 5.2 says its build replaces that throw; 5.3 Build
  gains a `svelte-floor` CI job (`pnpm devx peer-floor svelte`) coming with the Vite peers.
- `docs/milestones/README.md` "Test infrastructure", "Oldest supported framework" row: `svelte-floor` in M5 5.3.
- `docs/spec.md` 3.6: the build parses the block with the project's `svelte/compiler` and reports
  `svelte-parse-error` and `missing-style-module` at `.ucf` positions.
- `publicdocs/07-errors.md` "Component File Errors": rows for `svelte-parse-error` and `missing-style-module`.
- `docs/architecture.md`, `docs/plan.md`: no change (`BlockKind` contract unchanged, no plan decision moves).

## Fuzzing

None: the only oracle is Svelte's own parse position, which is the code under test plus an offset. 5.7's fuzz covers
Svelte blocks at large.

## Out of scope

- The `.svelte` output, `$style` rewrite, imports, stamping (5.2); Vite serving and plugin-svelte checks (5.3).
- Showing the compiler rules in the editor (5.10).
- The `svelte-floor` CI job itself (5.3).

## Done when

- `loadSvelteCompiler`, `BuildContext.root`, the two codes and the fixtures exist as above.
- Every test above passes; `pnpm devx check` green; docs updated; 5.1 ends with `- Status: done`.
- This todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.

## As shipped

- `NamedModule.ucf` reads `options.$theme` into `mode`, not `theme`: a top-level `theme` would make `$theme` a store
  and hide a broken key skip.
- Negative controls run: without the store skip, the rune skip, the key skip, the member-property skip, the module
  lookup or the first-line cut of Svelte's message, `blocks/svelte.spec.ts` fails.

## Decisions

- Compiler rules run in `svelteKind.build`, which ends in `target-not-built` until 5.2 (orchestrator: milestone 5.1
  puts them in `build()`; no contract change).
- `$style` always counts; another `$x` counts when x is a module or not a top-level binding; a declared x is a store
  and skipped (orchestrator: a real Svelte store must not be an error).
- Core's svelte peer is `^5.0.0`, as 5.3's Vite peers; 5.3 adds a `svelte-floor` job (orchestrator: plan.md
  "Framework versions" tests each range at both ends).
