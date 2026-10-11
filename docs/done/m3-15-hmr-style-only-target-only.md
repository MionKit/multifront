---
type: feature
spec: full-plan
status: done
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

### 1. Ids helper `packages/vite/src/ids.ts`

`TARGET_SUFFIX`, `splitId(id)` and `virtualTarget(path)` move out of `index.ts`, so `hmr.ts` uses them without a
circular import (`REACT_ID`, `SCOPE_HELPER` and `isUrlImporter` stay). New: `VIRTUAL_TARGETS` (`['react',
'svelte']`, the targets whose id names no file), which `virtualTarget` and `hmr.ts` both read. `index.ts` imports them.

### 2. Cache keeps the previous version `packages/vite/src/cache.ts`

- Types in `packages/vite/src/types.ts` (shared by `cache.ts` and `hmr.ts`): `UcfEntry`, `UcfSnapshot = {split,
  entry?}` and `UcfVersion = UcfSnapshot & {source, previous?: UcfSnapshot}`.
- One `store(file, source)` serves `splitUcf`, `loadUcf` and `updateUcf`. A changed source makes a new version whose
  `previous` copies only the old `split` and `entry`, never the old `previous` (no chain). Same source → the stored
  version.
- `updateUcf(file, source)` takes the source Vite's `read()` gave (it retries an empty mid-save read).
- `contextOf(version): Promise<UcfEntry>` (`version.entry ??= createBuildContext(...)`); `loadUcf` uses it.

### 3. `packages/vite/src/hmr.ts`: `ucfHotUpdate(cache, hasVuePlugin: () => boolean)`

Returns the Vite 8 `hotUpdate` handler, set on the pre plugin `multifront` in `index.ts`. Runs once per
environment and looks modules up in `this.environment.moduleGraph`.

- Not a `.ucf` file, or `type !== 'update'` → nothing (Vite's default).
- **Handed on untouched**: every listed module without a `ucf` query key (not ours), like `?raw`. The bare
  `/abs/Card.ucf` and `?vue&…` ids only when plugin-vue is in the app (`hasVuePlugin`): without it, nothing can have
  loaded them, and the bare node is only our watch edge, whose hand-on re-runs the react module.
- **One change, one diff**: Vite gives every environment's hook of one change the same `timestamp`. The first hook of
  a timestamp reads the source (`updateUcf(file, await read())`); the others reuse that version, so a later save
  never splits client and SSR. The base is the version the previous change of the file ended on, or, for the first
  change, the version the new source replaced (`previous`). No base (a save that changed nothing since we served the
  file, or a file never served) → only the handed-on modules.
- **Ours**, from the base split against the new one. Blocks are equal when `content` and `attrs` are (offsets
  ignored, as plugin-vue's `isEqualBlock`):
  - either split has splitter errors → every target module, and the style and class map module of every `<style>`
    of the new split, so the overlay shows the error and the fix clears it;
  - `<style>` `i` (in both) changed → `styleId(file, i)`; for a module style also `classMapId(file, i)`, only when
    its classes changed (old context's `styles[i].classes` against the new; no old context, or a failed one, counts
    as changed);
  - the number of `<style>` blocks, or any `scoped` or `module` attribute changed → also every loaded target module
    (react, svelte): stamping and the `$style` / named imports change;
  - `<react>` or `<svelte>` changed → that target's module by id (`getModuleById(file + TARGET_SUFFIX[target])`), if
    loaded;
  - a removed style index is never returned: its id would load the whole `.ucf` as CSS; the react module stops
    importing it and Vite prunes it.
- Result: the handed-on modules plus ours that exist in this environment's graph (the two never overlap). Nothing
  relevant (`<vue>` edit without plugin-vue, whitespace between blocks) → none of ours.
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
events counted. Click Counter to `3`. One `it` per edit, in order, each clearing the request list. `quiet(ms)` waits
until no request is in flight and none started or ended for `ms` (Playwright's `networkidle` resolves at once once
reached); its 500 ms also keeps the next write past chokidar's 50 ms throttle of change events on one file:

1. **Scoped style** `rgb(120, 40, 160)` → `rgb(10, 20, 30)`: poll `.counter`'s computed `color`, `quiet(500)`. Count
   `3`; exactly one request, `Counter.ucf?ucf&type=style&index=0&lang.css` (with `t` stripped); no `.ucf.react.tsx`.
2. **`<react>` text** `Clicks` → `Taps`: poll `.label`, `quiet(500)`. Count `3`; the only request is `Counter.ucf.react.tsx`
   (nothing with `type=style`); one `load` event.
3. **`<vue>` block** `Clicks` → `Hits`: wait for the dev server watcher's `change` on the file,
   `waitForRequestsIdle()`, `quiet(1000)` counted from the change event. No request at all; count `3`, label `Taps`.

After all three: one `load` event, no `warning`, `error` or `pageerror`. `removeApp` in `afterAll`.

Runs on this host (Chromium from `MULTIFRONT_CHROMIUM_PATH`) and in CI `check` and `react-floor` (Chromium since 3.9).

### `packages/e2e/build/hmr.spec.ts` (build area)

On a `copyApp('demo')` copy: a real dev server from the app's own config, plus an inline `enforce: 'pre'` recorder
whose `hotUpdate` (sorted right after ours) records per environment the file, the event type, an update's `await
read()`, the modules it got and `getModulesByFile(file)`. Before each case: the original `Counter.ucf` written
back, its update awaited, both environments crawled from `/src/App.tsx` (`transformRequest` of it,
`Counter.ucf.react.tsx` and every `?ucf` module that imports; Vite ties the react module's watch file to it only
when the module was in the graph before it loaded), plus `Counter.ucf?raw`, another plugin's module, handed on in
every case. After each edit: wait for a client and an SSR record of the written text. Same set of ours in both
environments:

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
| `<style scoped>` removed (the module style moves to index 0) | css0, react |
| `module` → `module="classes"` | css1, react |
| a `<svelte>` block added | none (its module never loaded) |
| last `</style>` deleted (splitter error) | css0, react (the new split has one style) |

Each case also checks the bare `/abs/Counter.ucf` node is in `getModulesByFile` and not in the result. Plus:

- the splitter error fixed again → css0, css1, map1, react;
- a `<vue>` edit (nothing compiles that version), then a module declaration edit → css1 and map1 (no old context);
- a second server with `plugins: [vue()]` inline: a `<vue>` edit and a scoped edit both hand on the bare node;
- a third server, in order: a save that changes nothing before any edit (only `raw`), an `App.tsx` edit and a
  `Counter.ucf` delete (both returned as Vite listed them).

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
