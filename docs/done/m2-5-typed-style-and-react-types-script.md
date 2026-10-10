---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.5
---

# Milestone 2.5: Typed `$style` and the `Card.ucf.react.tsx` types script

## Problem

After 2.4 the `react` embedded code is the bare `<react>` block, so `$style.card` is an unknown name to tsserver and
nothing gives an importer (or M5's `.d.ts` emit) a types script. Volar builds codes synchronously, but the build's
class map comes from `compileStyleAsync` with `modules`, and the sync `compileStyle` refuses `modules`
(`compiler-sfc.cjs.js:19983`). The editor must find class names on its own, the same ones the build finds.

Found while planning (compiler-sfc 3.5.42, probed in a scratch script):

- The sync `compileStyle` with `preprocessLang: 'scss'` runs sass `compileString` (sync), so `&__title` comes out as
  `.p__title`. less and stylus are sync there too.
- The build's module keys are more than class selectors: postcss-modules also exports `@keyframes` names and
  `@value` names. Classes under `:global(...)` or after a bare `:global` are not keys, `:local(...)` ones are, classes
  inside `:not(...)` are, `@keyframes :global(x)` is not. `composes` adds no keys.
- `postcss` 8.5.28 (what compiler-sfc already resolves to) and `postcss-selector-parser` 7.1.6 are both older than the
  30-day release age.
- The 2.4 test checks "every mapping has every feature on": navigation-only class mappings change that check (see Tests).

## Plan

1. **Core: `loadVueCompiler(root)`** (`packages/core/src/vueCompiler.ts`, new): the lookup now in
   `packages/vite/src/vueCompiler.ts:63-71` moves here unchanged ("`vue/compiler-sfc`, then `@vue/compiler-sfc`,
   resolved from `root`", same error message). Exported from `packages/core/src/index.ts`.
   `getVueCompiler` (`packages/vite/src/vueCompiler.ts:59`) keeps the borrow, then `return loadVueCompiler(root)`;
   its `createRequire` goes.
2. **Core: `VueCompiler` gains `compileStyle`** (`packages/core/src/types.ts:86`):
   `Pick<typeof CompilerSfc, 'compileStyleAsync' | 'compileStyle' | 'parse' | 'MagicString'>`.
3. **Core: one source for style compile options.** `packages/core/src/styles.ts`: the `preprocessLang` /
   `preprocessOptions` lines of `compileStyle` (`:55-57`) become an exported
   `stylePreprocessOptions(block): {preprocessLang, preprocessOptions}`, so the editor preprocesses exactly as the
   build does (`sass` → `{syntax: 'indented'}`). `moduleName(block)` (`:32`, the `module=""` → `$style` rule) is
   exported too. Both go into core's `index.ts`.
4. **language-tools types** (`src/types.ts`):
   - `EditorOptions { compiler?: VueCompiler }`, new, exported.
   - `EditorContext` gains `compiler: VueCompiler | undefined` (the style row needs it, and the rows are static).
   - `StyleClass.offset`: the offset of the name itself in the `.ucf` file (`card` in `.card`, `fade` in
     `@keyframes fade`), so one rule covers classes, keyframes and values. The milestone text changes to match.
   - `EditorStyleModule.classes` becomes `StyleClass[] | undefined`: `undefined` = the module could not be read.
5. **Style row** (`src/blocks/style.ts`), `editor(block, ctx)`: for a block with `moduleName(block)`, finds its keys and
   sets `ctx.modules[name] = {name, index, classes}` (a later same-name block wins, as in the build). Then returns the
   2.4 code as before (less, sass, stylus, postcss still get no code, but their modules are filled). Key finding in a
   new `src/styleClasses.ts`, `readStyleClasses(block, ctx): StyleClass[] | undefined`:
   - with `ctx.compiler`: `compiler.compileStyle({filename: split.filename, id: '', source: block.content,
     ...stylePreprocessOptions(block)})`, no `modules`, no `scoped`; any error → `undefined`.
   - without a compiler: a block with no preprocess lang is read raw; any other → `undefined`.
   - the CSS is parsed with `postcss.parse` (a throw → `undefined`). Keys, in walk order, deduped: the keys
     postcss-modules exports. Class nodes of each rule selector (`postcss-selector-parser`), skipping `:global(...)`
     contents and everything after a bare `:global` until `:local`; `@keyframes <name>` unless `:global(name)`;
     `@value <name>`. Rules inside `@keyframes` skipped.
   - `offset`: the first place the name is written in the raw block (comments and strings masked): a class as
     `.name` not followed by `[\w-]`, inside a rule prelude (text ending in `{`; for sass and stylus, anywhere);
     `@keyframes name`, `@value name`. Not written there (scss `&__title`) → no offset.
6. **React row** (`src/blocks/react.ts`): `types(block, ctx)` returns `{ext: '.tsx', code, map: undefined, mappings}`:
   the block content, then one line per `ctx.modules` entry whose name is an identifier, on its own line at the end:
   `declare const $style: {readonly card: string; readonly title: string};` (named module: `declare const classes`).
   A key that is not an identifier is quoted (`readonly "card-title": string`). An empty module gives `{}`. A module
   that could not be read gives the loose `{readonly [name: string]: string}`, so a style mid-edit never turns every
   `$style.x` red (the CSS service reports the style error itself).
   Mappings: the 2.4 content mapping (all features), plus per key with an `offset` one mapping
   `{sourceOffsets: [offset], generatedOffsets: [key start, inside any quotes], lengths: [name.length],
   data: {navigation: true}}`. `editor(block, ctx)` returns `[types(block, ctx)]`, so the `react` embedded code is the
   types script and `$style` is typed inside the block too.
7. **Shared context helper** (`src/context.ts`, new): `createEditorContext(split, options)`, the 2.4 `blocksOf`, and
   `editorFiles(ctx, sharedOnly?)`, the one loop over `EDITOR_BLOCK_KINDS` (shared first) that returns each block's
   files. `languagePlugin.ts` uses it (`codeId` stays there); `createUcfLanguagePlugin(options: EditorOptions = {})`
   (the first option, as 2.4 said).
8. **`getTypesScript(filename, source, target, options?: EditorOptions): EditorFile | undefined`**
   (`src/typesScript.ts`, new): splits, runs the shared rows to fill `ctx`, returns that target's `types()` on
   `split.targets[target]`, or `undefined` (no block, or no `types()` yet: vue, svelte). Exported from `src/index.ts`
   with `EditorOptions`.
9. **Dependencies** (`packages/language-tools/package.json`, via `pnpm add`): `postcss` `8.5.28`,
   `postcss-selector-parser` `7.1.6` (exact). Peer `@vue/compiler-sfc` `^3.5.0`, optional
   (`peerDependenciesMeta`), plus devDependency `@vue/compiler-sfc` `3.5.42` (packages/AGENTS.md: a package carries
   the devDependencies of its own peers). Runtime never imports it: the caller passes the compiler.

## Tests

All on this host and in CI's `check` job (`pnpm devx test`): Node, the pnpm install, root `sass` and `vue`. No new infra.

- **`packages/e2e/editor/styleClasses.spec.ts`** (new). `compiler = loadVueCompiler(FIXTURES_DIR)`. For every name in
  `listComponents()` plus `editor/StyleModuleEdges.ucf`:
  - **Same keys as the build**: the real async `createBuildContext(split, {root: FIXTURES_DIR, compiler,
    production: false})` gives `ctx.modules[name].classes` keys; `getTypesScript(filename, source, 'react',
    {compiler})` is parsed with the real TypeScript parser and its `declare const` lines give each module's keys.
    Same module names, same key sets.
  - **Jump targets**: every navigation mapping's source slice equals its key, lies inside a `<style module>` block of
    that module, and for `Card.ucf` lands on the `card` of `.card`.
  - **Snapshots**: `__snapshots__/Card.ucf.react.tsx` (`$style`) and `__snapshots__/Button.ucf.react.tsx` (`classes`).
  - **No compiler**: `getTypesScript` without options still reads `Button.ucf`'s plain CSS module (`primary`), and
    `Card.ucf`'s scss module gets the loose type.
  - `getTypesScript(..., 'vue')` and a file without `<react>` (`invalid/StylesOnly.ucf`) give `undefined`.
- **New fixture** `packages/e2e/fixtures/components/editor/StyleModuleEdges.ucf` (splitter-valid; has `<react>`):
  a `<style module lang="scss">` with `&__body`, `&-title` and `.card-title`, `:global(.outside) .inner`,
  `:not(.muted)`, `.wide` in `@media`, `.ghost` only in a `//` and a `/* */` comment; a `<style module="theme">` with
  `@value accent`, `@keyframes fade`, `@keyframes :global(spin)`, `:global .page .global-only`, `.fade-in`.
  The 2.2 grammar and 2.4 virtual code tests pick it up through `listComponents('editor')` (new snapshots there).
- **`packages/e2e/editor/virtualCode.spec.ts`** (2.4): the plugin gets `{compiler: loadVueCompiler(FIXTURES_DIR)}`;
  the react snapshots gain their `declare const` lines (reviewed). "Every feature on" becomes exact per kind: the
  content mapping has every feature, each other mapping is `{navigation: true}` and only that; the "source slice equals
  generated slice" and "whole block through the mapper" checks stay as they are.
- **`packages/core/test/vueCompiler.spec.ts`** (new, mirrors `src/vueCompiler.ts`): `loadVueCompiler(repo root)` is the
  module `vue/compiler-sfc` resolves to, and its sync `compileStyle` preprocesses `Card.ucf`'s scss block; from a fresh
  `mkdtemp(tmpdir())` it throws "could not find @vue/compiler-sfc". That case runs in a plain Node child
  (`test/vueCompiler.child.ts`) with no `NODE_PATH`: pnpm's bin shims put the store's hoisted `node_modules` there,
  so inside vitest any folder finds Vue.
- `packages/vite/test/vueCompiler.spec.ts` stays: its fallback case now runs through `loadVueCompiler`.
- `builtTypes.spec.ts` stays: the built `.d.ts` must still typecheck with the new exports.
- Each new check is confirmed to fail without its behaviour (a dropped bare `:global` rule, no keyframes key, no
  `@value` key, an offset off by one, an extra mapping flag).

## Docs

- `docs/milestones/m2-editor-basics.md`: `- Status: done` on 2.5; 2.5 text and "Hands to later milestones" match what
  shipped (`EditorOptions`, `ctx.compiler`, `StyleClass.offset` = the name, `EditorStyleModule.classes` possibly
  `undefined` and the loose fallback type, keys = what postcss-modules exports, `stylePreprocessOptions` and
  `moduleName` exported from core, `getTypesScript(..., {compiler})`, `createUcfLanguagePlugin(options)`).
- Every later milestone doc (m3 to m7) that uses these names: `m5-library-build.md` passes
  `{compiler: loadVueCompiler(root)}` to `getTypesScript`; `m6-svelte-target.md` types `$style` from `ctx.modules`.
- `docs/architecture.md` "Block kinds": the editor side of "Shared blocks run first" (the style row's `editor()` fills
  `ctx.modules` synchronously).
- `docs/plan.md:54`: the fallback lookup is core's `loadVueCompiler()`.
- `docs/spec.md`, `SETUP.md`, README: none. `publicdocs/`: the milestone's docs writer.

## Out of scope

- The language server, the TypeScript plugin, import resolution (2.6, 2.8, 2.9); the real tsserver go-to-definition
  test on `$style.card` is 2.9's.
- Codes for less, sass, stylus, postcss blocks (their modules are typed, their CSS gets no service).
- A project PostCSS config that renames classes (milestone risk, unchanged); caching compiles across keystrokes.
- vue / svelte `types()` (M4, M6). A fuzz test (none in the step).

## Decisions

- A module that cannot be read gets the loose `{readonly [name: string]: string}`; readable modules stay exact
  (orchestrator).
- Keys are what postcss-modules exports: classes, `@keyframes` names and `@value` names (orchestrator).
- No fuzz test in 2.5: the milestone puts none in this step (orchestrator).
- `stylePreprocessOptions(block)` and `moduleName(block)` are exported from core, so the build and the editor share
  them (orchestrator).

## Done when

- `getTypesScript(filename, source, 'react', {compiler})` gives `Card.ucf.react.tsx` with an exact `$style`, built
  synchronously, and the `react` embedded code is that script.
- The editor's keys equal the build's for every fixture of the test; `pnpm devx check` passes; the tests run in CI.
- `loadVueCompiler` in core is the only lookup; `getVueCompiler` uses it.
- Milestone doc, later milestone docs, architecture.md, plan.md match what shipped; the spec is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
