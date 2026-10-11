---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 4
step: 4.10
---

# Milestone 4.10: Imports from and into the Vue target

## Problem

The spec 4.1 and 4.2 rules must hold with plugin-vue in the middle, for `.vue` importers and inside `<vue>` blocks.
Checked on this host (Vite 8.2.2, plugin-vue 6.0.8, vue 3.5.42) with throwaway probe scripts on copies of
`Counter.ucf`, `imports/Icon.ucf`, `imports/ReactOnly.ucf` and a `UsesIcon.ucf` with a `<vue>` block.

Already works, no code needed:

- A bare import in a `.vue` file gets vue in build, dev client and dev SSR (the build bundles the bare `/abs/Counter.ucf`).
- `with { framework: 'vue' }` in a `<script setup lang="ts">` of a `.vue` file survives plugin-vue's script compile;
  no `with` / `framework` is left in dev client, dev SSR or build output.
- `UsesIcon.ucf`'s `<vue>` block importing `./Icon.ucf` gets the Vue Icon (SSR render has `aria-label="icon-vue-marker"`,
  the build has no React marker). Importer in dev: the bare `/abs/UsesIcon.ucf`; in build:
  `UsesIcon.ucf?vue&type=script&setup=true&lang.ts`.
- `ReactOnly.ucf` imported from a `.vue` file fails in build, dev client and dev SSR with
  `../../../components/imports/ReactOnly.ucf has no <vue> block; App.vue imports it as vue (missing-target-block)`.

**Bug 1: a `framework` attribute inside `<vue>` is mostly no error.**

- Dev client and dev SSR, with or without `lang="ts"`: no error. plugin-vue inlines the script into the bare `/abs/X.ucf`
  main module; that id is not `JS_LIKE` (`packages/vite/src/ids.ts:10`), so `multifront:attributes` never sees it, and
  Vite's import analysis silently drops the attribute.
- Build with a plain `<script setup>` (no `lang`): no error, same reason.
- Build with `lang="ts"`: error, but at `AttrInside.ucf?vue&type=script&setup=true&lang.ts:4:17`, a position in
  the compiled script.
- Cause: `react.check` reports `framework-in-block` (`packages/core/src/blocks/react.ts:110`); `vueKind.check`
  (`packages/core/src/blocks/vue.ts:12`) has no such rule.

**Bug 2: in a build, an import error of a `.vue` importer whose script plugin-vue does not inline (`lang="ts"`) points
into the compiled script**, e.g. `App.vue?vue&type=script&setup=true&lang.ts:4:14` for an import at `App.vue:3:14`.
plugin-vue makes script maps only when `build.sourcemap` is on, so `getCombinedSourcemap()` stops at the compiled
script; with maps the line is right but the file keeps its query. Spec 4.4: these errors sit at that import, in the
importer's own source.

## Decisions

- Orchestrator: plan approved.
- Orchestrator, Q1: bug 2 is fixed in this PR with `multifront:vue-importers` and its error test (the step "fixes what it
  finds"; the `.vue` importer path through plugin-vue's script compile is this step's subject).
- Orchestrator: keep the 4.12 and 4.14 hand-off lines in the milestone doc, and the `publicdocs/` fixes.
- Orchestrator: no fuzz test.

## Plan

1. **Core, `framework-in-block` for `<vue>`**:
   - Move `frameworkAttributes(program): Span[]` from `blocks/react.ts` into `imports/rewrite.ts`, beside `keyName` /
     `literalValue` (core-internal, not exported from `index.ts`). `react.check` imports it from there.
   - `scan.ts`: `FoundTag` gains `attrs`.
   - `vueKind.check`: for each top-level `<script>` of the block whose content holds `.ucf`, parse its content (up to
     `findClosingTag`) with oxc-parser, `lang` from its `lang` attribute (`ts`, `tsx`, `jsx`, else `js`); a parse error
     skips it (compiler-sfc reports syntax). Each framework attribute →
     `createDiagnostic(split, 'framework-in-block', …, frameworkInBlockMessage('vue'))`.
   - `buildTarget` runs `kind.check`, so our pre `transform` of the bare id fails at the `.ucf` position in dev, SSR and
     build, before plugin-vue, whatever the `lang`. The language server leaves the code to tsserver (`TSSERVER_CODES`).
2. **Fixtures**:
   - `imports/UsesIcon.ucf` gains a `<vue>` block: `<script setup lang="ts">` importing `./Icon.ucf`, and a template
     `<span class="uses-icon"><Icon /> uses-icon-vue-marker</span>`.
   - New `vue/AttrInside.ucf`: a `<script lang="ts">` with
     `export {default as AgainIcon} from '../imports/Icon.ucf' with {framework: 'vue'}`, a `<script setup lang="ts">`
     with `import Icon from '../imports/Icon.ucf' with {framework: 'vue'}`, and a template rendering `<Icon />`.
   - `apps/vue/src/App.vue` gains `import UsesIcon from '../../../components/imports/UsesIcon.ucf' with { framework: 'vue' };`
     and `<UsesIcon />`. Its bare `Counter.ucf` import is the importer-rule case.
3. **`.vue` importer errors at the import**: new pre plugin `multifront:vue-importers` in
   `packages/vite/src/attributes.ts`. Transform filter `{id: /\.vue$/, code: /\.ucf/}`, only with plugin-vue in the
   plugins. It parses the raw SFC with the borrowed compiler and runs the checks `multifront:attributes` runs
   (`rewriteImportAttributes` errors, then `resolveTarget`) on `script` and `scriptSetup` (not `src`), failing at
   `block.loc.start.offset + offset` in the `.vue` file. One helper serves both plugins. `multifront()` returns it
   between `multifront:vue-hmr` and `multifront:attributes`.

## Tests

All under `pnpm devx test`, on this host and in CI's `check`, `react-floor` and `vue-floor` jobs. No new infra
(in-process `vite.build()`, `createServer()`, `ssrLoadModule()`, as in 4.4 to 4.9). Copies come from `copyApp('vue')`.

- `packages/e2e/build/vue-imports.spec.ts`. A recorder plugin added to the app's own config logs each `.ucf`
  `resolveId` call (`order: 'pre'`: id, importer, environment) and resolves nothing.
  - Build (`buildApp`): `moduleIds` hold the bare `Counter.ucf`, `UsesIcon.ucf`, `Icon.ucf`, no `.react.tsx`; the recorder
    saw `Counter.ucf` from App.vue with no query, `UsesIcon.ucf?framework=vue` from `App.vue?vue&type=script…` (the
    attribute survived plugin-vue's compile and reached our rewrite), and `./Icon.ucf` with no query from
    `UsesIcon.ucf?vue&type=script…`; `expectNoAttribute()` on every chunk, no module id with `framework=`; the code has
    `icon-vue-marker` and `uses-icon-vue-marker`, not `icon-react-marker` / `uses-icon-react-marker`.
  - Dev (`withDevServer`), client and SSR: `transformRequest('/src/App.vue')` references `Counter.ucf` and `UsesIcon.ucf`
    by path (no `.react.tsx`), no attribute; the recorder saw `?framework=vue` from `/abs/App.vue`; the UsesIcon module
    references `Icon.ucf`. SSR `render()` of `entry-server.ts` has the Vue Icon inside `uses-icon` beside the Counter
    markup, and no React marker.
  - Errors, each its own copy with one import line added to `App.vue`:
    - `vue/AttrInside.ucf`: build rejects with `(framework-in-block)` at the `.ucf` position of the first
      `checkBlocks()` diagnostic, and lists the second; dev client and dev SSR reject with the same code and file.
    - `imports/ReactOnly.ucf`: build, dev client and dev SSR reject with
      `../../../components/imports/ReactOnly.ucf has no <vue> block; App.vue imports it as vue (missing-target-block)`.
    - `Counter.ucf` `with { framework: 'nope' }`: build (no `build.sourcemap`) and dev client reject with
      `(unknown-framework)` at the specifier in `App.vue` itself.
- `packages/core/test/blocks/vue.spec.ts`: `vue.check` on `vue/AttrInside.ucf` gives exactly two `framework-in-block`
  at hand-written line, column and span; `checkBlocks()` gives the same; `Counter.ucf` and `imports/UsesIcon.ucf` none.
- `packages/e2e/build/react-target.spec.ts`: `OTHER_MARKERS` gains `uses-icon-vue-marker`.

## Docs

- `docs/milestones/m4-vue-target.md`: 4.10 Build names the `vueKind.check` fix and `multifront:vue-importers`, and
  `- Status: done`; "Hands" `vueKind` row: its `check` also reports `framework-in-block`; 4.12 Test gains
  `vue/AttrInside.ucf` → `framework-in-block` from tsserver alone; 4.14 Build notes App.vue's `with { framework }`
  import needs `module: preserve` / `nodenext` in its tsserver project.
- `publicdocs/07-errors.md` (`framework-in-block` row) and `publicdocs/04-imports.md` (imports inside a component):
  an import in `<vue>` gets vue too.
- `spec.md`, `plan.md`, `architecture.md`: none (spec 4.1 already says it; no structure change).

## Out of scope

- Editor in-block resolution for `<vue>` (4.12), `.ts` importer types (4.13), `.vue` importers in tsserver (4.14).
- New rows in `fixtures/apps/imports/expected.ts` (the editor needs 4.12 / 4.13 first).

## Done when

- `vue-imports.spec.ts`, the core `vue.check` tests and the updated `react-target.spec.ts` pass here and in CI;
  `pnpm devx check` green.
- Milestone doc and public docs updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
