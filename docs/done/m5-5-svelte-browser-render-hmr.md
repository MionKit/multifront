---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.5
---

# Milestone 5.5: Browser render and HMR

## Problem

Svelte HMR must work through our plugin in a Svelte-only app and in a mixed app. Checked on this host (Vite 8.2.2,
plugin-svelte 7.3.0, svelte 5.57.0, plugin-vue 6.0.8, plugin-react 6.1.1, Chromium) with throwaway probes on
`copyApp()` copies:

- **The known trap is real.** In `apps/svelte-vite`, an edit to `Panel.ucf`'s `<svelte>` block sends one HMR `error`
  payload and shows `<vite-error-overlay>`: `…/Panel.ucf: the vue framework needs @vitejs/plugin-vue in your Vite
  plugins`. The Svelte module is never updated, and the next edit reloads the whole page.
  - Cause: plugin-svelte's `vite-plugin-svelte:hot-update` (`hotUpdate`, order post, client only) finds our
    `Panel.ucf.svelte.svelte` in its transform cache and first calls `this.environment.transformRequest(ctx.file)`.
    For a `.ucf` file that is the bare `/abs/Panel.ucf`, the Vue id (spec 4.3): our `load` returns the raw source and
    our `transform` throws `VUE_PLUGIN_MISSING`.
  - With plugin-vue present the request compiles the Vue target on every Svelte edit. A `.ucf` file with no `<vue>`
    block would throw `missing-target-block` there in the same way.
  - plugin-svelte 7.0.0, the floor, has the same `hot-update.js` logic.
- **Already works** (mixed app with react, vue, svelte plugins; and the Svelte-only app once the trap is gone):
  - a `<svelte>` edit sends one `js-update` for `Panel.ucf.svelte.svelte`, no reload, a `window` value survives;
  - a `<style>` edit (scoped index 0, or the module style) fetches only `Panel.ucf?ucf&type=style&index=N&lang.css`,
    and the Svelte element stays the same DOM node;
  - a `<react>` edit fetches only `Panel.ucf.react.tsx`, and a `<svelte>` edit keeps the React counter's count.

## Decisions

- Orchestrator, Q1: skip plugin-svelte's `transformRequest` of the bare `.ucf` file by wrapping its `hotUpdate` in
  `composeSveltePlugin()` (not a loadable bare id, not dropping the Svelte module from our hook's list).
- Orchestrator, Q2: no fuzz test.

## Plan

### 1. Skip plugin-svelte's request for the bare id (`packages/vite/src/svelteTarget.ts`)

- `composeSveltePlugin(config)` (already called from `configResolved`) also wraps the `hotUpdate` handler of the
  plugin named `vite-plugin-svelte:hot-update` (`HOT_UPDATE_PLUGIN_NAME`), with the same `wrappedHandlers` guard
  (a restart runs `configResolved` again on the same instance).
- The wrapped handler, when `options.file` ends in `.ucf`, calls plugin-svelte's with a context whose `environment`
  is a proxy: `transformRequest(url)` resolves `null` without transforming when `url === options.file`. Every other
  URL passes through, so plugin-svelte still transforms our `.ucf.svelte.svelte` module and still drops an update
  whose compiled output did not change. Any other file → plugin-svelte's handler as is.
- Safe to skip: plugin-svelte transforms the changed file first only to refresh its Svelte CSS cache, and our ids
  never emit a Svelte `<style>` (5.2).
- A small `withMember(target, key, value)` proxy helper (same file) serves this proxy, the `environment` one and the
  existing `getCombinedSourcemap` one.
- Rejected: making the bare id load something when plugin-vue is missing. That loses the "needs plugin-vue" error for
  a dev URL typed by hand. In a mixed app it still compiles the Vue target on every Svelte edit, and still throws for
  a file with no `<vue>` block. The milestone's other fallback, dropping the Svelte module from our hook's list,
  would stop the Svelte update itself.

### 2. Fixture app `packages/e2e/fixtures/apps/all-targets`

- `vite.config.ts`: `plugins: [react(), vue(), svelte(), multifront()]`.
- `index.html`: `<link rel="icon" href="data:," />`, `<div id="vue">`, `<div id="react">`, `<div id="svelte">`,
  `<script type="module" src="/src/main.tsx">`.
- `src/main.tsx`: imports `Panel.ucf` three times, `with {framework: 'vue'}` / `'react'` / `'svelte'`, and
  `Counter.ucf` `with {framework: 'react'}`:
  - `createApp(VuePanel, {heading: 'Vue panel'}).mount('#vue')`;
  - `createRoot(#react).render(<><ReactPanel heading="React panel" /><Counter start={2} /></>)`;
  - `mount(SveltePanel, {target: #svelte, props: {heading: 'Svelte panel'}})`.
- No tsconfig, as `apps/svelte-vite`. 5.8 and the exit test build on this app.

### 3. Test helper (`packages/e2e/browser/lib/requests.ts`)

`trackHmrPayloads()` gains `errors()`: the `err.message` of every `type: 'error'` payload.

## Tests

New `packages/e2e/browser/svelte-hmr.spec.ts`, browser area. Playwright Chromium on `startDev()` of a `copyApp()`
copy. Edits go to the copy's `components/Panel.ucf` through `editFile()`. Runs under `pnpm devx test` on this host
(`MULTIFRONT_CHROMIUM_PATH`) and in CI `check`, `react-floor`, `vue-floor` and `svelte-floor` (Chromium since 3.9,
plugin-svelte 7.0.0 in `svelte-floor`). No new infra.

Per app, in `beforeAll`:

- a `createLogger('silent')` with `warn`, `warnOnce` and `error` recorded, passed to `startDev()`; checked wired
  (`app.server.config.logger`);
- `collectConsole`, `trackRequests`, `trackHmrPayloads`, `load` events counted;
- `page.goto`, wait for `[data-marker="panel-svelte-marker"]`, then `globalThis.ucfMarker = 'kept'` in the page.

After each edit: `requests.quiet(500)`. The Svelte panel is found by `[data-marker="panel-svelte-marker"]` in both
apps. URLs: our Svelte module is served at `${panelFile}.svelte.svelte`, style modules at `/@fs${panelFile}?…`.

`describe('Svelte HMR in apps/svelte-vite')`:

1. `<svelte>` edit, `{$style.title}">{heading}</h3>` → `…{heading}!</h3>` (the `<react>` block also has
   `{heading}</h3>`). Checks:
   - the Svelte heading reads `Svelte panel!`;
   - the page's `ucfMarker` is `'kept'`, one page load (checked at the end);
   - requests and updated paths exactly `[Panel.ucf.svelte.svelte]`, no `full-reload`;
   - `errors()` empty, no `vite-error-overlay` element, no server log line.
   - Fails today: the overlay error above.
2. Scoped `<style>` edit, `$pad: 1rem;` → `$pad: 2rem;`:
   - the Svelte `.panel` `padding-top` goes from `16px` to `32px`;
   - requests exactly `[/@fs${panelFile}?ucf&type=style&index=0&lang.css]`, updated paths the same;
   - the Svelte `section` is the same DOM node (an `evaluateHandle` taken before the edit equals the one after);
   - marker kept, no error.
3. One page load, no `warning`, `error` or `pageerror` in the console.

`describe('Svelte HMR beside Vue and React in apps/all-targets')`: Vue, React and Svelte panels render; the React
counter is clicked from 2 to 3.

1. `<react>` edit, `<h3 className="heading">{heading}</h3>` → `{heading}!`:
   - `#react .heading` reads `React panel!`;
   - requests exactly `[Panel.ucf.react.tsx]` (the Svelte module is not fetched), updated paths the same;
   - count `3`.
2. `<svelte>` edit (as above):
   - heading `Svelte panel!`;
   - requests exactly `[Panel.ucf.svelte.svelte]`, updated paths the same;
   - React count still `3`, marker kept, no `full-reload`, no error.
3. Scoped `<style>` edit (as above):
   - the Svelte `.panel` `padding-top` is `32px`, same DOM node;
   - every request and updated path is a `Panel.ucf` style module of index 0: ours `?ucf&type=style&index=0` and
     plugin-vue's `?vue&type=style&index=0` for the Vue panel; none is a `.svelte.svelte` or `.react.tsx` module;
   - count `3`.
4. One page load, no console warning or error, no server log line.

Checked failing without the wrap of plan 1: svelte-vite case 1 (the heading never changes), case 2 (the page
reloaded, marker lost) and its last case (two page loads). With the wrap skipping every URL, both `<svelte>` edit
cases fail (plugin-svelte sees unchanged output and drops the update).

## Docs

- `docs/milestones/m5-svelte-target.md`:
  - 5.5 Build names the `hotUpdate` wrap in `composeSveltePlugin()` and `trackHmrPayloads().errors()`;
    `- Status: done`;
  - Risks "plugin-svelte's `hotUpdate` transforms the bare file id": becomes what shipped (the request for the bare
    id is skipped for `.ucf` files).
- `docs/plan.md` "5. Svelte target": one bullet: plugin-svelte's hot update transforms the changed file first, which
  for a `.ucf` file is the bare Vue id, so that one request is skipped.
- `spec.md` (7 HMR already says "Svelte HMR does the rest"), `architecture.md` (no structure change), `publicdocs/`:
  none.

## Fuzzing

None (decision Q2).

## Out of scope

- SSR and SvelteKit (5.6), root forwarding and its `all-targets` rule (5.8), the exit test.
- Keeping Svelte local state across a `<svelte>` edit (Svelte 5 HMR resets it, milestone risk).

## Done when

- `svelte-hmr.spec.ts` passes on this host and in CI `check` and `svelte-floor`. The CI log shows it executing.
- `pnpm devx check` green. Milestone doc and plan updated. Todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
