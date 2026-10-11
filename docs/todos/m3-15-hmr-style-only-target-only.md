---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 3
step: 3.15
---

# Milestone 3.15: HMR, style-only and target-only

## Problem

Today any edit to a `.ucf` file re-runs everything. A probe on a demo copy (real dev server, plugin-react, Chromium;
edits to the scoped style, `<react>`, `<vue>` and the module style) showed every edit requesting both CSS modules,
the class map and `Counter.ucf.react.tsx`. Vite hands on every module whose file is `Counter.ucf` (both styles, the
class map, the bare `/abs/Counter.ucf`). The class map is JS and accepts nothing, so the update climbs to the react
module, which accepts itself. The bare `/abs/Counter.ucf` node is only the edge the react module's `addWatchFile`
leaves (Vite creates it with `isSelfAccepting = false`), so handing it on re-runs the react module too. Fast Refresh
keeps the count, but spec 7 ("a style-only change hot-updates the style virtual module only") does not hold.

Second: `copyApp('demo')` breaks the demo. `src/App.tsx` imports `../../../components/Counter.ucf`, which a copy
under `.tmp/demo-x/` lacks. The HMR test edits a copy of `Counter.ucf`, so `copyApp` keeps the fixture layout.

## Plan

### 1. Ids helper `packages/vite/src/ids.ts` (moved from `index.ts:26-44`)

`TARGET_SUFFIX`, `splitId(id)`, `virtualTarget(path)` move out of `index.ts` unchanged, so `hmr.ts` uses them
without a circular import. New: `targetId(file, target)` (`file + TARGET_SUFFIX[target]`) and `isOwnId(id)` (query
has a `ucf` key: the style and class map ids). `index.ts` imports them.

### 2. Cache keeps the previous version `packages/vite/src/cache.ts`

- An entry (`UcfVersion = {source, split, entry?}`) gains `previous?: {split, entry?}`, set when an entry is replaced
  because its source changed. It copies only the old `split` and `entry`, never the old `previous` (no chain).
- `updateUcf(file, source): UcfVersion` splits the given source (Vite's `read()`, which retries an empty mid-save
  read) into the cache the same way `read()` does. Same source → the stored entry with its `previous`, so the client
  and SSR calls for one change diff against the same old version, even when a `load` re-read the file in between.
- `contextOf(version): Promise<UcfEntry>` (`version.entry ??= createBuildContext(...)`); `loadUcf` uses it.
- `export type UcfCache = ReturnType<typeof createUcfCache>`.

### 3. `packages/vite/src/hmr.ts`: `ucfHotUpdate(cache, hasVuePlugin: () => boolean)`

Returns the Vite 8 `hotUpdate` handler, set on the pre plugin `multifront` in `index.ts`. Runs once per
environment and looks modules up in `this.environment.moduleGraph`.

- Not a `.ucf` file, or `type !== 'update'` → nothing (Vite's default).
- `updateUcf(file, await read())`. No `previous` → we never served the file, none of our modules exist → nothing.
- **Handed on untouched**: every listed module that is not ours (`!isOwnId`). The bare `/abs/Card.ucf` and `?vue&…`
  ids only when plugin-vue is in the app (`hasVuePlugin`): without it, nothing can have loaded them, and the bare
  node is only our watch edge, whose hand-on re-runs the react module.
- **Ours**, from `previous.split` against the current split. Blocks are equal when `content` and `attrs` are
  (offsets ignored, as plugin-vue's `isEqualBlock`):
  - either split has splitter errors → every style, class map and target module of the file, so the overlay shows
    the error and the fix clears it;
  - `<style>` `i` (in both) changed → `styleId(file, i)`; for a module style also `classMapId(file, i)`, only when
    its classes changed (old context's `styles[i].classes` against the new; no old context, or a failed one, counts
    as changed);
  - the number of `<style>` blocks, or any `scoped` or `module` attribute changed → also every loaded target module
    (react, svelte): stamping and the `$style` / named imports change;
  - `<react>` or `<svelte>` changed → that target's module by id (`getModuleById(targetId(file, target))`), if loaded;
  - a removed style index is never returned: its id would load the whole `.ucf` as CSS; the react module stops
    importing it and Vite prunes it.
- Result: the handed-on modules plus ours that exist in this environment's graph, no duplicates. Nothing relevant
  (`<vue>` edit without plugin-vue, whitespace between blocks) → `[]`.
- `packages/vite/src/vueCompiler.ts`: `hasVuePlugin(plugins)` beside `getVueCompiler`, one `VUE_PLUGIN_NAME`.

### 4. `copyApp` keeps the fixture layout `packages/e2e/fixtures/index.ts:10`

- `copyApp(name)` copies `apps/<name>` to `<tmp>/<name>-xxxx/apps/<name>` and the shared `components/` to
  `<tmp>/<name>-xxxx/components`, and returns the app dir: relative `../../../components/…` imports work.
- `removeApp(appDir)` deletes the whole copy (`<appDir>/../..`, checked to sit right under `TMP_DIR`). The callers
  switch from `rm(root)`: `build/vue-reference.spec.ts`, `build/scope-id.spec.ts`, `build/style-parity.spec.ts`,
  `build/attributes-survive.spec.ts`.

## Tests

### `packages/e2e/browser/hmr-react.spec.ts` (browser area)

`copyApp('demo')`, `startDev(appDir)`, one Chromium page with `collectConsole`; every request recorded, `load`
events counted. Click Counter to `3`. One `it` per edit, in order, each clearing the request list:

1. **Scoped style** `rgb(120, 40, 160)` → `rgb(10, 20, 30)`: poll `.counter`'s computed `color`, `networkidle`. Count
   `3`; exactly one request, `Counter.ucf?ucf&type=style&index=0&lang.css` (with `t` stripped); no `.ucf.react.tsx`.
2. **`<react>` text** `Clicks` → `Taps`: poll `.label`. Count `3`; the only request is `Counter.ucf.react.tsx`
   (nothing with `type=style`); one `load` event.
3. **`<vue>` block** `Clicks` → `Hits`: wait for the dev server watcher's `change` on the file,
   `waitForRequestsIdle()`, a 1 s window, `networkidle`. No request at all; count `3`, label `Taps`.

After all three: one `load` event, no `warning`, `error` or `pageerror`. `removeApp` in `afterAll`.

Runs on this host (Chromium from `MULTIFRONT_CHROMIUM_PATH`) and in CI `check` and `react-floor` (Chromium since 3.9).

### `packages/e2e/build/hmr.spec.ts` (build area)

On a `copyApp('demo')` copy: a real dev server from the app's own config, plus an inline `enforce: 'pre'` recorder
whose `hotUpdate` (sorted right after ours) records per environment `await read()`, the modules it got and
`getModulesByFile(file)`. Before each case: the original `Counter.ucf` written back, its update awaited, both
environments crawled (`transformRequest` of `Counter.ucf.react.tsx` and every `?ucf` module it imports). After each
edit: wait for a client and an SSR record of the written text. Same set of ours in both environments:

| Edit | Ours returned |
| --- | --- |
| scoped declaration | css0 |
| module style declaration (`padding`) | css1 (dev class names ignore the CSS text) |
| module style gains `.extra` | css1, map1 |
| `<react>` text | react |
| `<vue>` text | none |
| whitespace between blocks | none |
| `scoped` removed | css0, react |
| third `<style>` added | react |
| `module` → `module="classes"` | css1, react |
| a `<svelte>` block added | none (its module never loaded) |
| last `</style>` deleted (splitter error) | css0, css1, map1, react |

Each case also checks the bare `/abs/Counter.ucf` node is in `getModulesByFile` and not in the result. A second
server with `plugins: [vue()]` inline: a `<vue>` edit and a scoped edit both hand on the bare node next to ours.

Runs in `pnpm devx test` on this host and in CI `check` and `react-floor`; no browser.

### Existing tests

The four `copyApp` callers keep passing with `removeApp`.

## Docs

- `docs/milestones/m3-react-and-imports.md` 3.15: Build text matches what ships (bare / `?vue&` hand-on only with
  plugin-vue, the `module` rule, "nothing relevant"), the Test line names `build/hmr.spec.ts`; `- Status: done`.
- `docs/milestones/m4-vue-target.md` "Needs from M3" HMR line: "(plugin-vue is in every M4 app)".
- `docs/milestones/README.md` "Shared names and fixtures": copies hold the shared `components/`; `removeApp()`.
- `docs/spec.md` (7 HMR, 4.3), `docs/plan.md`, `docs/architecture.md`: none (they already say this, name no file).
  `publicdocs/`: none (the milestone's docs writer).

## Fuzzing

None: the step names no fuzz test, and any oracle would re-derive the same diff rules.

## Out of scope

- The Vue HMR override (M4 4.9), Svelte HMR (M6 6.5), the exit test (3.16).
- Fresh source maps for the react module after an edit that only moves its block (as plugin-vue: offsets ignored).
- `create` and `delete` file events: Vite's default.

## Decisions

- Bare `/abs/Card.ucf` and `?vue&` modules are handed on only when plugin-vue is in the app (orchestrator).
- `copyApp` always copies the shared `components/` beside the app, plus `removeApp` (orchestrator).
- `packages/e2e/build/hmr.spec.ts` covers the branches the browser test cannot see (orchestrator).

## Done when

- `hmr-react.spec.ts` and `build/hmr.spec.ts` pass locally and in CI `check` and `react-floor`; the CI log shows both
  executing.
- The four `copyApp` callers pass; `pnpm devx check` green.
- This spec moved to `docs/done/`, matching what shipped; 3.15 is `- Status: done`.
- The simplify-comments pass ran on every touched source file, committed on its own.
