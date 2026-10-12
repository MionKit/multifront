---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.4
---

# Milestone 5.4: Imports from and into Svelte

## Problem

Spec 4.1 and 4.2 must hold when Svelte is the importer (a `.svelte` file) or the imported block (`<svelte>`).
Checked on this host (Vite 8.2.2, plugin-svelte 7.3.0, svelte 5.57.0) with throwaway probes on copies of the shared
components and a small app.

Already works, no code needed:

- In a `.svelte` file, a bare `import Panel from '…/Panel.ucf'` (importer rule), a static import
  `with { framework: 'svelte' }`, a re-export in `<script module>` and a dynamic `import()` with `with` all reach
  `multifront:attributes`, become `?framework=svelte` and resolve to the `.svelte.svelte` ids, in client build, SSR
  build (`build.ssr`), dev client and dev SSR; no `with` / `framework` is left in any output. Dev SSR `render()` of the
  app shows the Svelte markup.
- `Panel.ucf`'s `<svelte>` block importing `./PanelItem.ucf` (no query, importer `Panel.ucf.svelte.svelte`) gets
  `PanelItem.ucf.svelte.svelte`.
- `ReactOnly.ucf` imported from `App.svelte` fails in build, dev client and dev SSR with
  `../../../components/imports/ReactOnly.ucf has no <svelte> block; App.svelte imports it as svelte (missing-target-block)`;
  from a `<svelte>` block: `../../imports/ReactOnly.ucf has no <svelte> block; UsesReactOnly.ucf imports it as svelte`.
- `.svelte` importer errors (`with { framework: 'nope' }` → `unknown-framework`; `with: { framework: pick }` →
  `framework-attribute-not-literal`) fail at the import, in the importer's own source, in a build with or without
  `build.sourcemap`.
- The `imports` app's `src/Gallery.svelte` row (importer rule → svelte) works in dev client and SSR; it is still
  filtered out (`e2e/build/imports.spec.ts:19-20`).

**Gap 1: a `framework` attribute inside `<svelte>` is an error, but not as for React and Vue.** Only the post rewrite
(`packages/vite/src/attributes.ts:55-80`) catches it, on the compiled `X.ucf.svelte.svelte`: one error, the first in
compiled order, at the specifier. `checkBlocks` reports nothing. `react.check` and `vue.check` (`blocks/vue.ts:15-30`,
`attributesInScripts`) report every attribute at its `.ucf` span, from `load`, before the framework plugin.

**Gap 2: a `.svelte` importer's dev error names its file relatively.** Line and column are right, but `loc.file` is
`App.svelte`: the post rewrite passes an offset, and Vite's `_formatLog` (`vite/dist/node/chunks/node.js:31186-31197`)
maps it through plugin-svelte's map, whose source is relative. The same error in a `.vue` importer carries the
absolute path (`e2e/build/vue-imports.spec.ts:237`, green): `multifront:vue-importers` fails on the raw file first.

## Decisions

- Orchestrator: plan approved.
- Orchestrator, Q1: `framework-in-block` from `svelteKind.check`, sharing Vue's helper moved to `imports/rewrite.ts`
  (do what Vue does; "One code per error", "Core checks never load a compiler": oxc only). The post rewrite stays the
  fallback for an `import()` in markup.
- Orchestrator, Q2: first check the `.vue` importer; it gets an absolute `loc.file`, so gap 2 is ours: fixed in this
  PR, own commit, own test, not mapped twice.

- Review (automatic triage): fixed the per-script language (vite and core), the untested sort, parse-error and catch
  branches, the preprocess order, the restated context type, the copied test helpers and assertion blocks, the parallel
  importer plugins (one `multifront:importers`), the dead `langOf` export, the `ROWS` alias, the filter reaching our
  own target ids, and split the helper extraction into its own commit. The plugin-svelte gate is gone rather than
  tested: a `.svelte` importer needs svelte whatever plugin compiles it.

## Plan

1. **Core: `framework-in-block` from `svelteKind.check`**:
   - Move `attributesInScripts` out of `blocks/vue.ts:15-30` into `imports/rewrite.ts` as
     `frameworkInBlock(block, split, tags, target): Diagnostic[]` (beside `frameworkAttributes`; message
     `frameworkInBlockMessage(target)`; core-internal; `langOf` stops being exported). `vueKind.check` calls it with
     `'vue'`, no behaviour change.
   - Every script of the block parses in one language, the first script's `lang` (Svelte reads a lang-less
     `<script module>` as TypeScript when `<script lang="ts">` follows; compiler-sfc refuses two languages).
   - `svelteKind.check`: `styleInsideTarget(...)` plus
     `frameworkInBlock(block, split, topLevelTags(block.content, nests), 'svelte')` with the same `nests` (every
     non-void element): only the block's top-level `<script>` / `<script module>`.
   - `buildTarget` runs `check`, so `load` fails at the attribute, every one listed, before plugin-svelte. An `import()`
     in markup still falls to the post rewrite (error at the specifier).
2. **Vite: `multifront:importers`** (`packages/vite/src/attributes.ts`), M4's `multifront:vue-importers` renamed and
   given `.svelte` files too: pre, transform `order: 'pre'` (before plugin-svelte's preprocess, whose map names the file
   relatively too), filter `/(?:\.vue|(?<!\.ucf\.svelte)\.svelte)$/` and `.ucf` in the code (our own
   `X.ucf.svelte.svelte` targets are checked in `load`). Two script readers:
   - `vueScripts`: the borrowed compiler's descriptor, as before (only with plugin-vue).
   - `svelteScripts`: the project's `svelte/compiler` (`loadSvelteCompiler(root)`, no plugin-svelte check: a `.svelte`
     importer needs svelte anyway) parses the file with every `<style>` body blanked (a preprocessor's SCSS is no CSS;
     offsets stay); a parse error is left to plugin-svelte. `<script module>` and `<script>` in source order, all in the
     language of the first `lang`.
   - Both feed `scriptsError` (the first import error of a file's own scripts) and `failAtImport` (dev hands Vite the
     offset; a build maps it through `getCombinedSourcemap()`, else locates it in the code as is), which
     `multifront:attributes` uses too. Markup `import()` stays with the post rewrite.
3. **Fixtures** (`fixtures/components/svelte/imports/`):
   - `AttrInSvelte.ucf`: `<script module>` (no `lang`) re-exporting `../../imports/Icon.ucf` with
     `{ framework: 'svelte' }`; `<script lang="ts">` with `import Icon … with { framework: 'react' }` and
     `import('../../imports/Icon.ucf', { with: { framework: 'svelte' } })`; markup rendering both.
   - `AttrInSvelteMarkup.ucf`: the `import()` with `{ framework: 'svelte' }` inside `{#await}` in markup only.
   - `UsesReactOnly.ucf`: `<svelte>` importing `../../imports/ReactOnly.ucf`, rendering it.
4. **App `fixtures/apps/svelte-vite`** (`main.ts`, `index.html` and the 5.3 test unchanged):
   - `src/App.svelte`: `<script module lang="ts">` re-exporting Card `with { framework: 'svelte' }`; `<script lang="ts">`
     with a bare `import Panel`, `import Counter … with { framework: 'svelte' }`, and a dynamic
     `import('…/imports/UsesIcon.ucf', { with: { framework: 'svelte' } })`; markup rendering Panel, Counter and the
     lazy UsesIcon.
   - `src/app.ts`: `mount(App, …)`, the client build input (an app build drops a `.svelte` input's exports).
   - `src/entry-server.ts`: `render()` through `svelte/server` inside Vite (the test process would load a second Svelte
     runtime).
5. **`e2e/build/imports.spec.ts`**: drop the `.svelte` filter and its comment; the importer list regex gains `svelte`.
6. Shipped: `resolutionRecorder()` and `ucfPaths()` moved from `vue-imports.spec.ts` into `build/lib/references.ts`,
   and `withEditedApp()` (a copied app with text added after anchors) and `expectImportError()` (build plus dev
   environments fail with a code at a loc) are new in `build/lib/build.ts`, as both import specs use them.

## Tests

All under `pnpm devx test`, on this host and in CI `check`, `react-floor`, `vue-floor`, `svelte-floor`. In-process Vite
(`buildApp`, `withDevServer`), no new infra. Every case on a `copyApp('svelte-vite')` copy.

- New `packages/e2e/build/svelte-imports.spec.ts`, with a `resolveId` pre recorder:
  - Client build (`input: src/app.ts`): the recorder sees `Panel.ucf` from `App.svelte` with no query;
    `Counter.ucf?framework=svelte`, `Card.ucf?framework=svelte`, `UsesIcon.ucf?framework=svelte`; `./PanelItem.ucf`
    from `Panel.ucf.svelte.svelte` and `./Icon.ucf` from `UsesIcon.ucf.svelte.svelte`, no query. `moduleIds` hold the
    `.svelte.svelte` ids of Panel, PanelItem, Counter, Card, UsesIcon, Icon, no bare `.ucf`, no `.react.tsx`;
    `expectNoAttribute` on every chunk; Svelte markers in, vue / react markers out.
  - SSR build (`build.ssr: src/entry-server.ts`): same ids, `expectNoAttribute`, Svelte markers.
  - Dev client and SSR: `transformRequest('/src/App.svelte')` references exactly the four `.svelte.svelte` paths, no
    attribute; the recorder rows match. Dev SSR `render()` has the Panel, PanelItem and Counter Svelte markup and no
    other target's marker.
  - Errors, each its own copy whose `App.svelte` imports one more component and renders it:
    - `AttrInSvelte.ucf`: build rejects with `(framework-in-block)` at the first `checkBlocks()` diagnostic and lists
      the other two; dev client (its `.svelte.svelte` id) and dev SSR (the entry) reject with the same code and loc.
    - `AttrInSvelteMarkup.ucf`: `checkBlocks` empty; build, dev client and dev SSR reject with `(framework-in-block)` at
      the specifier's `.ucf` line and column.
    - `ReactOnly.ucf` from `App.svelte`, and `UsesReactOnly.ucf`: build, dev client and dev SSR reject with the exact
      messages above.
    - `unknown-framework` (static, `App.svelte`, `lang="ts"`), the same in a written lang-less `LangLess.svelte`, and
      `framework-attribute-not-literal` (dynamic, written `NonLiteral.svelte`, in `<script module>`): build (no
      sourcemap), dev client and dev SSR fail with `loc` equal to the absolute file and the import's line and column.
      Without the `.svelte` check the dev `loc.file` was `LangLess.svelte`. More rows: `ScriptFirst.svelte` (an error in
      each script, `<script>` first: the first in the file wins), `ModuleTs.svelte` (TypeScript in a lang-less
      `<script module>`), `Preprocessed.svelte` (`svelte({preprocess: vitePreprocess()})`, a `<style lang="scss">`).
    - A `.svelte` importer that does not parse fails with plugin-svelte's own error (`vite-plugin-svelte:compile`).
- `packages/core/test/blocks/svelte.spec.ts`: `svelte/errors/ImportParseError.ucf` (a `.ucf` import in a script that
  does not parse) gives only `svelte-parse-error`. `svelte.check` on `svelte/imports/AttrInSvelte.ucf` gives exactly three
  `framework-in-block` at hand-written line, column and span; `checkBlocks()` the same; `AttrInSvelteMarkup.ucf`,
  `UsesReactOnly.ucf`, `Panel.ucf`, `imports/UsesIcon.ucf` none. `OTHERS` leaves out `AttrInSvelte.ucf`.
- `packages/core/test/blocks/vue.spec.ts`: unchanged, green (the move kept Vue's behaviour).
- Floor: dry run before pushing (`CI=1 pnpm devx peer-floor svelte` on a throwaway worktree, then the new spec).

## Docs

- `docs/milestones/m5-svelte-target.md`: 5.4 Build names the `svelteKind.check` rule, the markup fallback and
  `multifront:importers`; `m4-vue-target.md` names `multifront:importers` where it named `multifront:vue-importers`; 5.4 Test the fixtures and app files; `- Status: done`; "Hands" milestone 7:
  `svelteKind.check` also reports `framework-in-block`.
- `publicdocs/07-errors.md` (`framework-in-block` row) and `publicdocs/04-imports.md` ("Imports Inside a Component"):
  an import in `<svelte>` gets svelte.
- `spec.md`, `plan.md`, `architecture.md`: none (spec 4.1 and 4.4 already say it; no structure change).

## Fuzzing

None: 5.7 holds the Svelte fuzz; no cheap oracle beyond the build tests.

## Out of scope

- `.svelte` importers in tsserver or Svelte's editor (5.9, 5.11); the editor `imports.spec.ts` `.svelte` filter (5.11).
- HMR (5.5), SvelteKit (5.6).

## Done when

- `svelte-imports.spec.ts`, the core svelte and vue check tests and `imports.spec.ts` with the Gallery row pass here and
  in CI `check` and the three floor jobs; `pnpm devx check` green.
- Milestone doc and the two public pages match what shipped; this todo reconciled and moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
