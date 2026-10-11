---
type: feature
spec: full-plan
status: ready
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

## Plan

1. `packages/vite/src/vueTarget.ts`:
   - `export type SfcSources = Map<string, {code: string; source: string}>`: per `.ucf` file, the latest SFC code our
     transform made and the raw source it came from.
   - `export function wrapVueCompiler(plugins: readonly Plugin[], sfcSources: SfcSources): void`. Reads plugin-vue's
     `api.options.compiler` (found by `VUE_PLUGIN_NAME`); nothing when plugin-vue or its compiler is missing, or the
     compiler is already one of ours (a module-level `WeakSet`: an in-process restart runs `buildStart` again on the
     same plugin instances). Else sets `api.options = {...api.options, compiler: wrapped}`, where `wrapped` is the
     compiler with:
     - `parse(source, options)`: calls the real one; when `sfcSources.get(options.filename)?.code === source`, sets
       `sourcesContent` of every block map (`template`, `script`, `scriptSetup`, `styles`, `customBlocks`) to the raw
       source, one entry per `sources` item. Mutating is safe: compiler-sfc's parse cache hands back the same
       descriptor, and the patch is idempotent.
     - `compileScript(descriptor, options)`: the same on its result's `map`, keyed on `descriptor.filename` and
       `descriptor.source`.
     - every other export passed through unchanged (user's own `compiler` option included: we wrap whatever plugin-vue
       resolved).
   - `VuePluginApi` (`packages/vite/src/types.ts:25-28`): `compiler` typed as plugin-vue's
     `NonNullable<Options['compiler']>` where the wrapper needs the full module type, still assignable to core's
     `VueCompiler` for `getVueCompiler()`.
2. `packages/vite/src/index.ts`:
   - `const sfcSources: SfcSources = new Map()` in `multifront()`.
   - the pre transform (`:189-194`) records `sfcSources.set(id, {code: built.code, source: code})` after building.
   - the pre plugin gains `buildStart: {order: 'post', handler() { wrapVueCompiler(config!.plugins, sfcSources); }}`
     (checked in scratch: Rolldown build and Vite dev both run it after plugin-vue's `buildStart`).
3. No new mapping code: the map from 4.2 already passes through our transform (the step's "passes the map" item holds
   today; the test proves it).

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
- **Dev server** (`withDevServer(root, {css: {devSourcemap: true}}, …)`): transform `/@fs<root>/../../components/Counter.ucf`,
  then its `type=style&index=0&scoped=` import; take the CSS from `__vite__css` and its inline `sourceMappingURL` map:
  - the `.counter[data-v-…]` rule traces to `Counter.ucf`, the line of `.counter {` under `<style scoped>`, column 0;
  - that map's `sourcesContent` is the file's text (fails today).
- **Build error**: an entry written into the copy at test time (`src/template-error.ts`:
  `export {default} from '../../../components/vue/TemplateError.ucf' with {framework: 'vue'};`, the pattern of
  `vue-scope-id.spec.ts`), built as the only input. The build rejects; the message names
  `TemplateError.ucf:<line>:<column>` of `<span` (Vue's 1-based column), and `errors[0].loc` has the same file, line
  and column.

## Docs

- `docs/milestones/m4-vue-target.md`: 4.6 Build line names `wrapVueCompiler()` and why; `- Status: done`; the "Hands"
  row for `packages/vite/src/vueTarget.ts` gains "the compiler wrapper that gives sub-request maps the `.ucf` text";
  4.9 gains one line: its `read` override also records the new SFC code in `sfcSources`, so a style-only hot update
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
- 4.9's HMR `read` override (only its step text gains the `sfcSources` note).

## Done when

- `packages/e2e/build/vue-sourcemaps.spec.ts` passes, and its two `sourcesContent` checks fail without the wrapper.
- `pnpm devx check` passes.
- Docs above updated; this todo moved to `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
