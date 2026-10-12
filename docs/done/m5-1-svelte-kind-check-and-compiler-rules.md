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

### 2. `loadSvelteCompiler(root)`: `packages/core/src/compilers.ts` (was `vueCompiler.ts`)

- One private `loadFromRoot(root, ids, missing)` serves `loadVueCompiler` and `loadSvelteCompiler`:
  `require.resolve(id, {paths: [root]})` then `require(path)`. Svelte not found → `multifront: could not find svelte.
  Install svelte in your project.` Found but broken → its own error.
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
   - walk `instance`, `module`, `fragment` (typed as svelte's `AST.Root`); `Identifier` nodes named `$x` (x not
     empty, not starting with `$`, so `$:` and `$$props` stay Svelte's); skip non-computed `key`, `imported`,
     `exported`, `local` names and non-computed member `property`; skip a child of a `TS*` node unless it is its
     `expression` (`($style as X)` is a use, `type $Row` is not); skip runes (`state`, `derived`, `effect`, `props`,
     `bindable`, `inspect`, `host`);
   - `$style` → needs `ctx.modules.$style` or `ctx.modules.style` (`module="style"`), message `<svelte> uses $style,
     but no <style module> exists; add one`. Always ours, even beside a `style` prop (milestone Risks);
   - `$x` (x ≠ style) → ours when `ctx.modules[x]` exists; else, when `x` is bound at the top level of the instance or
     module script (import local, `let`/`const`/`var` pattern name, function or class name, also under `export`), it
     is a store: skipped; else `<svelte> uses $x, but no <style module="x"> or store named x exists`.
   - sorted by `start`.
4. Errors → `throw new DiagnosticsError(errors)`. Clean → throw `target-not-built` (today's message and range); 5.2
   replaces that throw with the `.svelte` file.

- `types.ts`: `DiagnosticCode` gains `'svelte-parse-error' | 'missing-style-module'`. Every kind now has a `build`, so
  `BlockKind.build` is required and `buildTarget` loses its dead `!kind.build` guard; callers drop their `build!`.
- `check` unchanged, compiler free. `checkBlocks` reports `style-inside-target`; `buildTarget(split, ctx, 'svelte')`
  (Vite's `load`) reports it first, then the compiler rules, then `target-not-built`. No Vite change.

### 5. Fixtures: `packages/e2e/fixtures/components/svelte/errors/`

- `TopLevelStyle.ucf`: a `<style>` at the top level of the block (plus a root `<style>`) → `style-inside-target`.
- `StyleInHead.ucf`: `<svelte:head><style>…</style></svelte:head>` → nothing.
- `UnclosedBrace.ucf`: `<script lang="ts">` with `$props()`, `<h2>{title</h2>` → `svelte-parse-error`.
- `StyleWithoutModule.ucf`: only `<style scoped>`; `$style.card` and `($style as Record<string, string>).box` in
  script, `$style.text` in markup → three `missing-style-module`.
- `WrongModuleName.ucf`: `<style module="classes">`; `$classes.title` fine; `{[$theme]: …}` in script, `$style.card`,
  `$theme.accent` and `$classes[$theme]` in markup → four `missing-style-module`.
- `NamedModule.ucf` → nothing: `<style module>` + `<style module="classes">` used as `$style` and `$classes`, a
  `style` prop, `$state`, `$derived`; stores of every top-level form used as `{$name}` (a `<script module>` export,
  an import, `const`, object and array destructuring with defaults and rests, a function, a class);
  `import {$fetch as fetcher}`, `import type {$Props}`, `type $Row`, `export {shared as $exported}`, `{$theme: …}`,
  `options.$theme`.
- `Runes.ucf` (`<svelte:options customElement>`): every rune and its member forms → nothing.
- `Legacy.ucf`: `$:` and `$$props`, `$$restProps` → nothing.
- `ModuleNamedStyle.ucf`: `$style` with only `<style module="style">` → nothing.

## Tests

All in `pnpm devx test`, on this host and in CI's `check` job; they need only the root `svelte` devDependency.

- `packages/core/test/blocks/svelte.spec.ts` (new), on `react.spec.ts`'s pattern:
  - a row per `svelte/errors/` fixture ("has a row for every fixture"), hand-written `{code, line, column, text}` of
    what `buildTarget(split, ctx, 'svelte')` throws, `target-not-built` left out (`ctx` from `createBuildContext`,
    root `FIXTURES_DIR`);
  - `checkBlocks(split)` gives only the compiler-free `style-inside-target`;
  - every diagnostic: line/column match its start offset, range inside the block content, message starts `<svelte>`
    (`<style>` for `style-inside-target`), one line, no URL; `missing-style-module` text is exactly `$style` /
    `$theme`, its two messages pinned;
  - valid fixtures (`Legacy`, `ModuleNamedStyle`, `NamedModule`, `Runes`, `StyleInHead`) throw only
    `target-not-built`;
  - a JSON snapshot per fixture (`__snapshots__/svelte/errors/<name>.json`);
  - sweep: every other fixture with a `<svelte>` block (`Card`, `Button`, `editor/GrammarEdges`, `react/AllBlocks`,
    `ReactDefaultSpecifier`) throws only `target-not-built`.
- `packages/core/test/compilers.spec.ts` + `compilers.child.ts` (were `vueCompiler.*`; the child takes a mode:
  `vue`, `svelte`, `svelte-build`): the repo root resolves the same module as
  `createRequire(<repo>/package.json)('svelte/compiler')`; a temp folder with no svelte gets the "could not find"
  message (child process, no `NODE_PATH`), and `buildTarget(…, 'svelte')` there throws it as a plain `Error`, not a
  `DiagnosticsError`; a broken `node_modules/svelte` passes its own error on.
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
- `docs/architecture.md`: the `BlockKind` snippet's `build` is required. `docs/plan.md`: no change.
- `docs/milestones/m2-editor-basics.md`: the Vue loader test is `compilers.spec.ts`.
- `scripts/lib/env.mjs` `REGISTRY`: a `NODE_PATH` row (the compiler and editor tests clear it).

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

- Fixture names avoid a top-level binding of the bare name (`mode`, `element`, `$exported`): a declared `theme` would
  make `$theme` a store and hide a broken skip.
- Negative controls run, each one breaking `blocks/svelte.spec.ts`: every name-key skip, the TS skip and its
  `expression` exception, the computed exception, the `module="style"` lookup, the `$` and `$$` skips, each rune,
  each store form (import, variable, function, class, export unwrap, module script, every pattern branch), the module
  lookup and the first-line cut of Svelte's message.
- Review: `patternNames` stays its own beside `react/scope.ts`'s (oxc and ESTree ASTs differ; sharing needs a cast).

## Decisions

- Compiler rules run in `svelteKind.build`, which ends in `target-not-built` until 5.2 (orchestrator: milestone 5.1
  puts them in `build()`; no contract change).
- `$style` always counts; another `$x` counts when x is a module or not a top-level binding; a declared x is a store
  and skipped (orchestrator: a real Svelte store must not be an error).
- Core's svelte peer is `^5.0.0`, as 5.3's Vite peers; 5.3 adds a `svelte-floor` job (orchestrator: plan.md
  "Framework versions" tests each range at both ends).
