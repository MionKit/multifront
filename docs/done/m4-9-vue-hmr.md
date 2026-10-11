---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.9
---

# Milestone 4.9: HMR for the Vue target

## Problem

plugin-vue's `handleHotUpdate` reads the changed file itself (`read()`), so for `Counter.ucf` it parses the raw
`.ucf`, not our SFC code: a `<react>` edit looks like a full Vue change and reloads the component.

plugin-vue also only re-renders (state kept) after a `.vue` edit: its previous-descriptor cache is filled for `.vue`
files only. For any other file it emits `reload` (a re-mount, state lost), so a `<template>` edit to `Counter.ucf`
would reset the count even with SFC code.

Checked on this host (Vite 8.2.2, plugin-vue 6.0.8, vue 3.5.42) with a throwaway probe script:

- `<react>`-only edit: plugin-vue hands on `[]` with the `read` override, `[Counter.ucf]` without it.
- `<template>` edit, with or without the override: the new main module has no `export const _rerender_only`, so
  `__VUE_HMR_RUNTIME__.reload()` runs and re-mounts.
- plugin-vue 6.0.3 (the floor) has the same `handleHotUpdate` and `transformMain` code.

## Decisions

- Orchestrator: the two deviations from the step text are accepted (the post transform adding `_rerender_only`, and
  recording only when plugin-vue stores the code); the 4.9 Build text is updated to match.
- Orchestrator, Q1: plugin-vue's `handleHotUpdate` drops the non-Vue modules (the React module, our `?ucf` style
  modules) of a file imported both as Vue and as React. Fixed in 4.11, where that app first exists: this PR adds it
  to 4.11's Build and Test text.
- Orchestrator, Q2: no fuzz test.
- Each new test was checked failing with its piece taken out: no `read` override (the three browser edits), no
  `_rerender_only` line (count back to 2), no `version.sfc` (style map text), the record always written (style map
  line after a `<react>` edit), no record (a second transform), no `shouldForceReload` check (`undefined`), a
  parse-error guard (no re-render after a typo fix), no plugin-vue script options (no re-render of `GlobalProps`).
- Review (automatic triage):
  - Fixed: tests for the import reload, the typo and the `<vue>` block removal; the parse-error guard and the
    no-`<vue>` early return dropped (plugin-vue diffs those too); plugin-vue's script options passed to
    `compileScript()`; `BlockText` from core's `Block`; `HotPayload`; the record holds `{source, sfc}`; a `Set`;
    `cssMap` inlined; a separate type import; `vuePluginApi()`; spec text.
  - Kept: the `_rerender_only` duplicate guard (a plugin-vue in the peer range that writes the line would otherwise
    produce a duplicate export); the `ctx.read` override seen by later `handleHotUpdate` plugins (none of ours, and
    restoring it needs a hook after plugin-vue's on that context, which Vite gives no plugin); a shared browser HMR
    scaffold with `hmr-react.spec.ts` (saves lines only by rewriting that untouched spec).

## Plan

1. `packages/vite/src/vueTarget.ts`, the record (was `handedSources: Map<string, string>`):
   `handedVersions: Map<string, {source, sfc}>`; `handedToVue(file, source, sfc)`, `warmUpVue()` compares `.source`.
   Our transform passes its SFC code. The HMR hook reads the SFC code last handed from it.
2. `packages/vite/src/vueTarget.ts`, new `vueHmrPlugin(cache: UcfCache, vueOf: () => {compiler, options} | undefined)`
   (plugin-vue's compiler and its `api.options`): `name: 'multifront:vue-hmr'`, `enforce: 'pre'`.
   - `handleHotUpdate(ctx)`:
     - returns `undefined` unless the file ends in `.ucf`, plugin-vue is in the plugins and the file was handed to it
       before (never handed: plugin-vue holds no descriptor and skips it);
     - `cache.updateUcf(file, await ctx.read())` (the split cache refresh, and the split to build from);
     - `sfc = vueSfcCode(source, split.blocks, file).code`, also with no `<vue>` block left (plugin-vue then sees
       template and script gone, and our transform reports the missing block); `version.sfc = sfc` (a style-only
       update keeps the `.ucf` text in devtools, 4.6); `ctx.read = () => sfc` (Vite hands every `handleHotUpdate`
       plugin one shared context, so plugin-vue's hook, next, sees it; so does any later `handleHotUpdate` plugin,
       accepted);
     - `hotChange(compiler, options, file, before.sfc, sfc)` parses both with compiler-sfc `parse()`, parse errors
       kept as plugin-vue's hot update keeps them (a fixed template typo still re-renders):
       - `rerenderOnly`: template changed (and still exists); scripts, styles, custom blocks equal in content and
         attrs; and `next.shouldForceReload(imports)` is false, `imports` from `compileScript()` of the old
         descriptor with plugin-vue's own `script` options and `propsDestructure` (a type only
         `script.globalTypeFiles` resolves would throw without them; a TS `<script setup>` template starting to use
         an import needs the script again). A throwing `compileScript()` → false (reload, the safe side);
       - `stored`: the template or some style changed, the cases where plugin-vue stores the new descriptor.
     - `rerenderOnly` files in a `Set`; `stored` → `handedToVue()`, so the update's sub-requests need no warm-up.
       Not stored (a `<react>`-only edit): plugin-vue keeps the old descriptor, stale positions included, and the
       record stays old, so the next sub-request warms up.
   - Post transform, `transform: {order: 'post', filter: {id: VUE_INCLUDE, code: '__VUE_HMR_RUNTIME__'}}` (after
     plugin-vue's; only the dev client main module has its HMR code): when the last hot update of `id` was
     `rerenderOnly` and the code has no `export const _rerender_only` (a future plugin-vue writing it would make ours
     a duplicate export), append plugin-vue's own `.vue` line
     `export const _rerender_only = __VUE_HMR_RUNTIME__.CHANGED_FILE === "<id>"` (`map: null`, nothing moves). Its
     `accept` handler then calls `rerender()`; its `CHANGED_FILE` check still reloads an update a dependency caused.
3. `packages/vite/src/hmr.ts`: `sameBlock()` takes `Pick<Block, 'content' | 'attrs'>` blocks and is exported, for
   `hotChange()`. The local `type UcfCache` moves to `types.ts`; `VuePluginApi.options` gains `script`.
   `vuePluginApi(plugins)` in `vueCompiler.ts` replaces three copies of the plugin-vue lookup.
4. `packages/vite/src/index.ts`: `return [pre, vueHmrPlugin(cache, vueOf), attributesPlugin(options)]`, `vueOf`
   reusing the memoized `api.vueCompiler`. Own plugin: Vite never calls `handleHotUpdate` on a plugin with
   `hotUpdate`.

## Tests

All under `pnpm devx test`, on this host and in CI's `check`, `react-floor` and `vue-floor` jobs. No new infra:
Playwright Chromium (3.9), dev servers and `copyApp()` exist. Each spec uses its own `copyApp('vue')`, removed after.

`packages/e2e/browser/vue-hmr.spec.ts` (new), Playwright on the `apps/vue` dev server (`startDev()`), edits to the
copy's `Counter.ucf`:

- `apps/vue/index.html` gains `<link rel="icon" href="data:," />`, as the other apps have: Chromium's
  `/favicon.ico` 404 is a console error;
- tracks loads, console, requests (`trackRequests()`) and the HMR payloads off Vite's websocket (new
  `trackHmrPayloads(page)` in `browser/lib/requests.ts`, Playwright `framereceived`, Vite's `HotPayload`);
- click the counter from 2 to 3;
- `<template>` edit (`<span class="label">Clicks</span>` → `Hits`): label `Hits`, count `3`, one `update` naming
  Counter.ucf's main module, no `full-reload`, one page load;
- scoped `<style>` edit (`rgb(120, 40, 160)` → `rgb(10, 20, 30)`): computed `.counter` color changes, count `3`, every
  update path is Counter.ucf's `?vue&type=style&index=0` sub-module;
- `<react>` edit (`<span className="label">Clicks</span>` → `Taps`): after the watcher's `change` and a quiet window,
  no request, no `update` naming Counter.ucf, no `full-reload`; count `3`, label still `Hits`;
- a `<template>` edit starting to use the script's `ref` import (`{{ typeof ref }}`): the label reads `function` (a
  re-render reads `undefined`), the count is back to `2` (mounted again), one `update`, no `full-reload`;
- no `warning`, `error` or `pageerror`; one page load.

`hotUpdatesOf(file)` (new, `build/lib/build.ts`): a recording plugin whose post `hotUpdate`, last of every hook, settles
`next()` with the client module ids of the next change to `file`. Used by the three build specs below.

`packages/e2e/build/vue-hmr.spec.ts` (new), the dev client main module after hot updates (`withDevServer()`):

- a template typo (`</spam>`) fails it, and its fix re-renders (has the `_rerender_only` line);
- with the `<vue>` block removed it fails naming `<vue>`, and once restored it builds again;
- new fixture `vue/GlobalProps.ucf` (`defineProps<GlobalLabelProps>()`, the type declared in
  `vue/global-props.d.ts`), with `vue({script: {globalTypeFiles}})`: a template edit re-renders.

`packages/e2e/build/vue-sourcemaps.spec.ts`, two new cases in the existing `a dev server with css.devSourcemap`
describe (its first case moves onto the shared `devStyleCss()` / `expectRuleMapped()`):

- after a scoped `<style>` edit, the style sub-module's map holds the edited `Counter.ucf` text and maps
  `.counter[data-v-` to its line (fails without `version.sfc` set in the hook);
- after a `<react>`-only edit adding a line above the styles, the style map holds the edited text and maps the rule to
  its new line (fails if the record is always written).

`packages/e2e/build/vue-cache-miss.spec.ts`, `transformsOf()`: after a scoped `<style>` hot update, requesting the
style sub-module transforms `Counter.ucf` no second time (the record skips the warm-up).

## Docs

- `docs/milestones/m4-vue-target.md`: 4.9's Build text names the post transform, `hotChange()` and the conditional
  record, `- Status: done`; "Risks": the not-formal-API list gains the `_rerender_only` export and `CHANGED_FILE`,
  upstream proposal adds a previous descriptor for non-`.vue` files. 4.11's Build and Test text gain the
  non-Vue-modules fix (decision Q1).
- `docs/plan.md` "Building on plugin-vue", item 3, the HMR bullet: also the `_rerender_only` line after a
  template-only change, and the record only when plugin-vue stores the code.
- `spec.md`, `architecture.md`: none (spec 7 already says "Vue HMR does the rest"; no structure change).
  `publicdocs/`: none.

## Fuzzing

None (decision Q2).

## Out of scope

- An app importing one file as Vue and as React (4.11).
- SSR HMR (`server.ts`), Vue custom blocks, Vapor mode.

## Done when

- The three specs pass on this host and in CI; CI log lines show `vue-hmr.spec.ts` executing.
- `pnpm devx check` green; milestone doc and plan updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
