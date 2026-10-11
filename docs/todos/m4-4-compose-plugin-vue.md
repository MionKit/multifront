---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 4
step: 4.4
---

# Milestone 4.4: compose plugin-vue (real path, include, exclude, pre transform)

## Problem

`import Counter from './Counter.ucf'` in a Vue app does not build. The vue pick resolves to the bare `/abs/Counter.ucf`
id (M3), but our `load` (`packages/vite/src/index.ts:160`) still throws `target-not-built` on purpose, and plugin-vue's
`include` (default `/\.vue$/`) never takes `.ucf` files. Facts checked on plugin-vue 6.0.8 (`dist/index.mjs:1627-1770`)
and with a scratch build:

- `api.include` / `api.exclude` setters throw once plugin-vue's `options` hook ran. Our `configResolved` runs before it.
- The `transform` hook filter is `makeIdFiltersToMatchWithQuery(include)` + `/[?&]vue\b/` minus `exclude`, on the full
  id. With `/\.ucf$/` in `include`, our `Card.ucf?ucf&type=style&index=0&lang.css` passes it; plugin-vue then tests only
  the path and runs `transformMain` on the CSS. Seen: a Vue app that also imports `Counter.ucf` as react fails without
  the exclude, builds with it.
- A second `configResolved` on the same plugin instances (in-process `server.restart()` with inline plugins) would call
  the setter after `options`: "server restart failed". So the setter is called only when our pattern is not there yet.
- The milestone's pre-bundling risk ("check during 4.4") shows: the scan externalizes every vue pick (`index.ts:117`),
  so a dependency imported only inside a `<vue>` block is not found at startup. Feeding the scan the raw
  `<script setup lang="ts">` also misses a template-only import (TypeScript stripping drops it); `compileScript()` keeps it.

## Decisions

- The `<vue>` dependency scan is in this step: the milestone's risk "Dependency pre-bundling … Check during 4.4. If it
  shows, add `.ucf` to the scanner" applies, and it shows.
- The restart guard (setters called only when our pattern is missing) stays, with its test: plugin-vue's setter throws
  on a second `configResolved`, and 4.7 tests `server.restart()`.
- The dev-URL error (the bare `.ucf` requested with no importer, without plugin-vue) stays, with its test: the same
  error on the other entry path.
- No fuzz test: the new inputs are configs and plugin orders, no cheap oracle.

## Plan

### 1. `packages/vite/src/vueTarget.ts` (new)

- `VUE_INCLUDE = /\.ucf$/`, `UCF_SUB_REQUEST = /\.ucf\?(?:.*&)?ucf\b/` (our style and class map ids),
  `VUE_PLUGIN_MISSING = 'the vue target needs @vitejs/plugin-vue in your Vite plugins'`.
- `composeVuePlugin(plugins)`: for every plugin named `vite:vue` (`VUE_PLUGIN_NAME`, exported from `vueCompiler.ts`),
  `api.include` = the user's patterns (single or array, kept) + `VUE_INCLUDE`; `api.exclude` = the user's patterns +
  `UCF_SUB_REQUEST`. Each setter only when its list lacks our RegExp, so a repeat `configResolved` is a no-op.
- `vueScanScript(split, compiler)`: `vueSfcCode()` → `compiler.parse()` → `compiler.compileScript(descriptor, {id})`,
  `moduleType` from the script's `lang`; `export default {}` on split errors, parse errors, no `<script>`, or a throw.
- `VuePluginApi` moves to `types.ts` (two files use it) and gains `include` / `exclude`, typed like plugin-vue's `Api`.

### 2. `packages/vite/src/index.ts`

- `configResolved`: `composeVuePlugin(resolved.plugins)`.
- New pre `transform`, `filter: {id: VUE_INCLUDE}` (bare id, no query): no plugin-vue → error naming the file;
  else `cache.contextOf(cache.updateUcf(id, code))` → `buildTarget(split, ctx, 'vue')` → `{code, map}`;
  `DiagnosticsError` → `this.error(rollupError(...))`.
- `load`: the `target-not-built` guard goes; the bare vue id returns the raw source after the `server.fs.allow` check
  and `addWatchFile`.
- `resolveId`: the scan follows vue picks when plugin-vue is in the plugins, to `file + '.vue.ts'` (`importerFromId`
  maps it to the `<vue>` block, Vite's scan treats it as `.ts`); a real vue pick without plugin-vue →
  `importErrorMessage(path, importer, VUE_PLUGIN_MISSING)`.
- `scanPlugin.load`: also `/\.ucf\.vue\.ts$/` → `vueScanScript()`, with `getVueCompiler()` directly so the scan never
  fixes the build context's compiler.
- `diagnostics.ts`: `importErrorMessage()` takes a plain message.

### 3. `packages/core/src/types.ts`

- `VueCompiler` gains `'compileScript'`.

### 4. Fixture app `packages/e2e/fixtures/apps/vue/` (new)

- `index.html`, `vite.config.ts` (`[vue(), multifront()]`), `src/main.ts`, `src/App.vue` (bare imports of `Counter.ucf`,
  `vue/VBind.ucf`, `./Plain.vue`), `src/Plain.vue`, `src/bothTargets.ts` (`Counter.ucf` as vue and as react).

### 5. Existing fixtures and tests

- `apps/imports/no-default` and `apps/imports/custom-importers` configs gain `vue()` (their vue rows need it now).
- `react-target.spec.ts`: `target-not-built` for svelte only; the vue pick in react-basic gets the plugin-vue error.
- `apps/scan-deps`: config gains `vue()`; `Mount.ucf` gains a `<vue>` block importing `TraceMap` from
  `@jridgewell/trace-mapping`, used only in the template; new entry `importer.vue`.

## Tests

All in `pnpm devx test` (real `vite.build()` / `createServer()`), on this host and CI's `check` job. No new infra.

- `packages/e2e/build/vue-compose.spec.ts`, on a `copyApp('vue')` copy:
  - plugin-vue before `multifront()` (the app's config) and after it: Counter, VBind (`useCssVars`) and Plain compile,
    `setCount` (`<react>` marker) absent, scoped CSS of both `.ucf` files present;
  - `vue({include: [/\.vue$/]})`: `Plain.vue` and `Counter.ucf` both compile;
  - `index.html` + `src/bothTargets.ts` builds (the exclude);
  - no plugin-vue: `src/bothTargets.ts` fails naming `Counter.ucf` and its importer; a dev URL of `Counter.ucf` fails;
  - `server.restart()` with inline plugins: no logged error, `Counter.ucf` still compiles as Vue.
- `packages/e2e/build/scan-deps.spec.ts`: `importer.vue` discovers `@jridgewell/trace-mapping`; each entry finds only
  its own block's dependency.
- `react-target.spec.ts` updated; `imports.spec.ts`, `fs-allow.spec.ts`, `hmr.spec.ts` stay green.

## Docs

- `docs/milestones/m4-vue-target.md`: 4.4 Build / Test gain the scan, dev-URL and restart lines; the pre-bundling risk
  is settled; `- Status: done`.
- `publicdocs/04-imports.md` note and `publicdocs/07-errors.md` `target-not-built` row: vue picks build now (with
  plugin-vue), svelte picks and editor vue picks still give `target-not-built`.
- spec 4.3, architecture and plan "Building on plugin-vue" already describe include + pre transform; naming the exclude
  in plan.md is 4.7's job.

## Out of scope

- `componentIdGenerator` and CSS module names (4.5), source maps (4.6), cache-miss warm-up (4.7), SSR (4.8), HMR (4.9).
- `src` scripts inside `<vue>` in the scan. A plugin-vue peer-floor CI job.

## Done when

- Every test above passes in `pnpm devx test`, and `pnpm devx check` is green.
- Milestone doc and public docs updated; the todo moved to `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
