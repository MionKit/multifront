---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.6
---

# Milestone 4.6: source maps and error locations for the Vue target

## Problem

The step asks for proof that devtools, stack traces and build errors point at `Counter.ucf`, plus any fix the proof
finds. Checked on plugin-vue 6.0.8, Vite 8.2.2, compiler-sfc 3.5.42, with scratch builds of `apps/vue`:

- **Positions are right already.** Our pre transform returns `vueSfcCode()`'s map (`packages/vite/src/index.ts:189-194`,
  through `built()` and `vueKind.build`), and Vite chains it. In a production build with `build.sourcemap: true`, the
  bundle's `toDisplayString(count.value)` traces to `count` inside `{{ count }}` (Counter.ucf line 12, column 75: after
  the non-ASCII `title="Zähler 𝄞"`, so UTF-16 columns hold), and `const count = … ref(__props.start ?? 0)` to line 6,
  column 2. No segment lands outside the `<vue>` content or the `<style>` blocks. In dev with `css.devSourcemap: true`,
  the scoped style sub-module's `.counter` rule traces to line 32 (the rule under `<style scoped>`). A template with an
  unclosed tag fails the build with `TemplateError.ucf:<line>:<column>` of the bad tag (plugin-vue's `loc`, Vue's
  1-based column).
- **Found: devtools show a blanked copy of the file.** Every map that starts at a plugin-vue sub-request carries the SFC
  code as its source text, so devtools open "Counter.ucf" with the `<vue>` tags and the whole `<react>` block turned to
  spaces. Hit in the build: the `lang="ts"` script is the sub-module `Counter.ucf?vue&type=script&setup=true&lang.ts`,
  and all 55 Counter mappings of the bundle use a `sources` entry whose content is the SFC code. Hit in dev: every
  `?vue&type=style` sub-module. Cause: plugin-vue's `load` returns `block.map` (`dist/index.mjs:1740-1756`), from
  compiler-sfc's `parse` (block maps, content = parsed source) or `compileScript` (its `map`). Our map never enters
  those chains, and a later transform cannot replace the load map's content (Vite and Rolldown keep the first map's).
- **The fix point.** plugin-vue resolves its compiler in `buildStart` (`dist/index.mjs:1724-1729`:
  `options.value.compiler ||= resolveCompiler(root)`) and calls `compiler.parse` / `compileScript` through
  `options.value.compiler`. A `buildStart` ordered `post` runs after it and can hand back the same compiler, wrapped.
  Prototyped in scratch: with `parse` and `compileScript` putting the raw `.ucf` text in their maps, every Counter.ucf
  entry of the bundle and the dev style map hold the real file, positions unchanged (same-length code).

## Decisions

- Orchestrator: fix the blanked source text here with `wrapVueCompiler()` (option A), not a Risks line. Settled by the
  step's Deliverable ("devtools … point at `Counter.ucf`") and AGENTS.md (a related issue is fixed in the same PR).
  The wrapper goes through plugin-vue's public `api.options` only, never its internals (packages/AGENTS.md: compose,
  never fork or deep-import). The fix lands in its own commit, with the two `sourcesContent` checks that fail without it.

- Review: the `getVueCompiler()` unwrap folded into the fix commit; the SFC code and source paired on the split
  cache's version, not a second table; source text read on use (a watch rebuild after a `<react>`-only edit kept the
  old text); the dev and watch tests on copies of their own; a test for the restart guard.

## Plan

1. `packages/vite/src/vueTarget.ts`, `export function wrapVueCompiler(plugins: readonly Plugin[], sourceBehind)`,
   `sourceBehind(file, code)` giving the raw source behind a file's latest SFC code. Reads plugin-vue's
   `api.options.compiler` (found by `VUE_PLUGIN_NAME`); nothing when plugin-vue or its compiler is missing, or the
   compiler is already one of ours (an in-process restart runs `buildStart` again on the same plugin instances). Else
   sets `api.options = {...api.options, compiler: wrapper}`, typed as plugin-vue's own `NonNullable<Options['compiler']>`
   (`VuePluginApi.options.compiler` now uses that type too), where `wrapper` is the compiler with:
   - `parse(code, options)`: calls the real one, then every block map (`template`, `script`, `scriptSetup`, `styles`,
     `customBlocks`) of a `.ucf` file gets a `sourcesContent` getter.
   - `compileScript(descriptor, options)`: the same on its result's `map`.
   - every other export passed through unchanged (a user's own `compiler` option included: we wrap whatever plugin-vue
     resolved).
   - The getter returns the raw source, one entry per `sources` item, while `code` is still the file's latest SFC code;
     else the text compiler-sfc wrote. Read on use, not copied: plugin-vue keeps its `compileScript` result per
     descriptor, and a same-length `<react>`-only edit leaves the SFC code (so the descriptor) the same while the
     `.ucf` text changes. A map that already has the getter (compiler-sfc's parse cache hands the same descriptor back)
     is left alone.
2. `packages/vite/src/vueCompiler.ts`: `wrappedCompilers`, a `WeakMap` from each wrapper to the compiler plugin-vue
   resolved. `getVueCompiler()` unwraps through it, so core keeps compiling with that exact compiler (the existing
   "borrows the compiler plugin-vue resolved" tests); it is also the restart guard.
3. The split cache (`packages/vite/src/cache.ts`, `types.ts`) keeps the pair, no second table: `UcfVersion.sfc` is the
   SFC code our pre transform made from that version's `source` (`index.ts`, the transform sets it after `built()`),
   and `cache.sourceBehind(file, code)` returns `source` while `sfc === code`.
4. `packages/vite/src/index.ts`: the pre plugin gains `buildStart: {order: 'post', handler() {
   wrapVueCompiler(config!.plugins, cache.sourceBehind); }}` (Rolldown builds and Vite dev both run it after
   plugin-vue's `buildStart`).
5. No new mapping code: the map from 4.2 already passes through our transform (the step's "passes the map" item held
   already; the test proves it).

## Tests

All in `packages/e2e/build/vue-sourcemaps.spec.ts`, run by `pnpm devx test` on this host and in CI's `check` job
(real `vite.build()` and dev servers, no new infra). `copyApp('vue')` in `beforeAll`, `removeApp` after. Expected
lines and columns are computed from the fixture text, never hard-coded.

New fixture `packages/e2e/fixtures/components/vue/TemplateError.ucf`: a `<react>` block first (so the bad tag's `.ucf`
line differs from its line inside the block), then a `<vue>` block whose `<template>` holds `<span>never closed` inside
a `<div>`.

- **Production build** (`buildApp(root, {build: {sourcemap: true}})`), the chunk holding `Counter.ucf`, traced with
  `@jridgewell/trace-mapping` (root devDependency, already there):
  - `toDisplayString(count.value)` → `Counter.ucf`, the line and UTF-16 column of `count` in `{{ count }}`;
  - the `<script setup>` statement `const count = … ref(__props.start ?? 0)` → `Counter.ucf`, `const count` on its line;
  - every `sources` entry ending in `Counter.ucf` has `sourcesContent` equal to the file's text (fails today: the
    script sub-module's entry holds the blanked SFC code);
  - no mapping into `Counter.ucf` lands outside the `<vue>` block's content and the root `<style>` blocks.
- **Dev server** (`withDevServer(copy, {css: {devSourcemap: true}}, …)`, on a copy of its own: compiler-sfc's parse
  cache is keyed on source and filename, so with the build's copy it would hand dev the descriptor the build patched): transform `/@fs<root>/../../components/Counter.ucf`,
  then its `type=style&index=0&scoped=` import; take the CSS from `__vite__css` and its inline `sourceMappingURL` map:
  - the `.counter[data-v-…]` rule traces to `Counter.ucf`, the line of `.counter {` under `<style scoped>`, column 0;
  - that map's `sourcesContent` is the file's text (fails today).
- **Build error**: an entry written into the copy at test time (`src/template-error.ts`:
  `export {default} from '../../../components/vue/TemplateError.ucf' with {framework: 'vue'};`, the pattern of
  `vue-scope-id.spec.ts`), built as the only input. The build rejects; the message names
  `TemplateError.ucf:<line>:<column>` of `<span` (Vue's 1-based column), and `errors[0].loc` has the same file, line
  and column.

- **Watch build** (own copy, `build: {watch: {}, sourcemap: true}`): after the first bundle, a same-length edit in the
  `<react>` block (`Clicks` → `Clocks` there only); every `Counter.ucf` entry of the rebuilt `.js.map` holds the edited
  text (fails with copied text instead of the getter).
- **Restart** (`build/vue-compose.spec.ts`, the existing restart test): after `server.restart()`, `getVueCompiler()`
  still returns `vue/compiler-sfc` itself (fails without the restart guard).

## Docs

- `docs/milestones/m4-vue-target.md`: 4.6 Build line names `wrapVueCompiler()` and why; `- Status: done`; the "Hands"
  row for `packages/vite/src/vueTarget.ts` gains "the compiler wrapper that gives sub-request maps the `.ucf` text";
  4.9 gains one line: its `read` override also sets the new version's `sfc`, so a style-only hot update
  (no main re-transform) keeps the `.ucf` text in devtools.
- `docs/plan.md`, "Building on plugin-vue": new item 5, "Devtools show the `.ucf` file", with the cause and the
  `buildStart` wrapper; item 1 notes the borrowed compiler is the wrapped one.
- `docs/spec.md` 3.4 "Source maps": add that every map's source text is the `.ucf` file itself.
- `docs/architecture.md`: none, no structure change. `publicdocs/`: no page describes source maps.

## Fuzzing

None. The milestone puts no fuzz test here, and there is no cheap oracle: compiled output has no 1:1 token
correspondence with the source. The "no mapping outside `<vue>` and `<style>`" assertion covers the blanking property
deterministically.

## Out of scope

- Production CSS source maps (Vite emits none for CSS assets in a build).
- SSR source maps, browser-level stack trace checks.
- 4.9's HMR `read` override (only its step text gains the `sfc` note).

## Done when

- `packages/e2e/build/vue-sourcemaps.spec.ts` passes, and its three `sourcesContent` checks fail without the wrapper.
- `pnpm devx check` passes.
- Docs above updated; this todo moved to `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
