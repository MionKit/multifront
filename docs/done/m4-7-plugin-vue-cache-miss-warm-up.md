---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.7
---

# Milestone 4.7: plugin-vue cache misses, warm-up before sub-requests

## Problem

plugin-vue keeps its SFC descriptors in a module-level cache (`descriptorCache.ts`, `dist/index.mjs:46-84` in
plugin-vue 6.0.8), filled by its main transform from our SFC code. A `?vue&type=…` sub-request that misses it makes
plugin-vue's `load` (`dist/index.mjs:1737-1756`) call `getDescriptor()`, which reads the raw `.ucf` with
`fs.readFileSync` and throws. Checked on Vite 8.2.2 with a copy of `apps/vue`:

- A fresh `vite` CLI dev server whose first request is
  `/@fs/…/Counter.ucf?vue&type=style&index=0&scoped=…&lang.css`: 500, "At least one `<template>` or `<script>` is
  required in a single file component. …/Counter.ucf".
- A fresh process whose first SSR request is the same URL through `server.environments.ssr.transformRequest()`: the
  same throw.
- A fresh process: client request main + style, the `<style scoped>` color changed on disk (watcher off), an
  in-process `server.restart()`, the style URL as first request: the OLD color. plugin-vue's cache outlives the restart
  (module level) and holds the old descriptor.
- `vite build --watch` then a `<react>` edit: rebuilt fine before this step, CSS and JS carrying the new production scope id. A guard.

## Decisions

- Orchestrator, Q1: build the `vue-floor` CI job in this step, own commits. M3's hands say "milestone 4 adds
  `vue-floor`", no M4 step owns it, M4 Risks rely on "the CI matrix of supported plugin-vue versions", and the
  milestones README says the step whose test first needs a piece builds it. 4.7 is the first remaining step whose test
  depends on plugin-vue internals. A real failure at the floor gets fixed here (own commit, own test).
- Orchestrator, Q2: the record is keyed on the source only, as the step text says. A production build then a dev
  server in one process, or two roots, hit plugin-vue's module-level cache the same way for `.vue` files.
- Orchestrator: no fuzz test.
- Review (automatic triage):
  - Fixed: a test that a current record skips the warm-up (blocking); concurrent warm-ups of one file share one load,
    with a test; the fresh-process helper reuses `withDevServer` (watcher kept, ignoring every file: Vite's
    `mergeConfig` drops `watch: null`) and a promisified `execFile` with a 50 s kill, takes no options and exports
    no type; CLI children stop in `onTestFinished`; the app copy gets a `package.json` so the CLI's dep cache stays in
    it; the spec names where each result was measured and the `types` → `follow` rename.
  - Kept: `handedToVue()` / `warmUpVue()` in `vueTarget.ts` (4.9 calls `handedToVue()` too, and the record sits
    beside the rest of the plugin-vue composition); two floor jobs, not a matrix (the `react-floor` check name stays,
    and the YAML anchors already share every step); a style-only hot update re-runs the main transform once until
    4.9's `read` override records the new source (the 4.9 text says so).

## Plan

1. `packages/vite/src/vueTarget.ts`:
   - module-level `handedSources = new Map<string, string>()`: file → the `.ucf` source whose SFC code plugin-vue last
     got from us. Module level: the same lifetime as plugin-vue's cache (one process, across restarts and plugin
     instances).
   - `handedToVue(file, source)`: records it.
   - `warmUpVue(context, file, source)`: if `handedSources.get(file) !== source`, `await context.load({id: file})`.
     That runs our load + transform and plugin-vue's `transformMain`, which fills its cache. A file never handed
     (fresh process) or changed on disk since (restart) gets warmed. An error in the main transform becomes the
     sub-request's error, naming the right `.ucf` line. The sub-requests of one file arrive together on a cold
     cache (one per `<style>` block): a module-level map of pending loads makes them share one.
2. `packages/vite/src/index.ts`, the pre plugin:
   - `load`: after the `server.fs.allow` check (a denied file is never warmed), for `query.has('vue')` on a `.ucf`
     path, `await warmUpVue(this, path, (await cache.splitUcf(path)).source)` and return `undefined`: plugin-vue loads
     the sub-request from a warm cache.
   - `transform`: `handedToVue(id, version.source)` after `built()` succeeds.
   - Builds never warm up: a sub-request loads only after its main module transformed, so the record matches.
3. The `vue-floor` CI job:
   - `scripts/lib/peer-floor.mjs`: a `vue` row in `FLOOR_PEERS`: peers `@vitejs/plugin-vue` and `@vue/compiler-sfc`,
     and `vue` taking the `@vue/compiler-sfc` floor (`vue` pins its own compiler-sfc exactly, so the two move together).
     The row key for such packages is now `follow` (it was `types`: `vue` is no types package), the react row too.
   - `.github/workflows/ci.yml`: a `vue-floor` job beside `react-floor`: install, `pnpm devx peer-floor vue`, the VS
     Code cache, Chromium, `pnpm devx test --reporter verbose`.
   - `@vitejs/plugin-vue` was `^6.0.0`, but 6.0.0 to 6.0.2 peer `vite ^5 || ^6 || ^7`: no install beside our
     `vite ^8.0.0` passes `strictPeerDependencies`. 6.0.3 is the first with `^8.0.0-0`, and every test passes on it:
     the range is `^6.0.3` (own commit).
   - `@vue/compiler-sfc` was `^3.5.0` in core, language-tools and vite. A local floor run (a throwaway worktree,
     `CI=1 pnpm devx peer-floor vue`, then bisecting the override) failed below 3.5.15: before 3.5.12 compiler-sfc
     uses the legacy Sass API (a stray `sourceMappingURL` comment, other error positions: `styles.spec.ts`,
     `style-parity.spec.ts`), and before 3.5.15 its production inline template map is broken for every SFC
     (vuejs/core#12701: `vue-sourcemaps.spec.ts`). Vue's bugs, not ours: the range is `^3.5.15` in all three
     packages and the getting-started page (own commit).
   - `vue-sourcemaps.spec.ts` searched the bundle for `const count = /* @__PURE__ */ ref(`, a mark compiler-sfc adds
     only from 3.5.27: it now finds the statement with or without it (own commit; same position traced).
   - Measured locally on this branch (the throwaway worktree): the full suite passes at the floor (plugin-vue 6.0.3,
     compiler-sfc and vue 3.5.15), 2173 tests. The CI run of `vue-floor` comes with the PR.

## Tests

`packages/e2e/build/vue-cache-miss.spec.ts`, run by `pnpm devx test` on this host and in CI's `check`, `react-floor` and
`vue-floor` jobs. No new CI infra beyond `vue-floor`: child processes, as the editor tests use. Each case is a fresh
process with its own `copyApp('vue')`, removed after; the copy gets a `package.json`, so the CLI's dep cache lands in
it. Expected scope ids come from core's `scopeId(rootRelativePath(root, file), source, production)`. "Failed before the
fix" and "passed before the fix" below were measured on this host, with the tests committed before the fix.

Helper `packages/e2e/build/lib/freshProcess.ts`:

- `startViteCli(root, args, env)`: spawns `node --conditions=source <vite>/bin/vite.js …args` in `root`, with
  `NO_COLOR=1`; `waitForOutput(pattern, count)`, `output()`, `stop()`. The spec stops it in `onTestFinished`, so a
  timed-out test leaves no process behind.
- `runFreshDevServer(root, steps)`: runs `node --conditions=source` on the same file (`import.meta.main`) through a
  promisified `execFile`, killed after 50 s. The child runs `{env, request}`, `{edit: {file, from, to}}` and
  `{restart: true}` steps on one `withDevServer()` whose watcher ignores every file, so no hot update refreshes
  plugin-vue's cache behind a case's back, and prints each request's code as JSON.

Cases:

- **First dev request** (vite CLI, `--configLoader native --port 0`, `NODE_ENV=development`): fetch the
  `type=style&index=0&scoped=<id>&lang.css` URL of `Counter.ucf` first. 200, its `__vite__css` holds
  `.counter[data-v-<dev id>]` with `rgb(120, 40, 160)`, no `/error/i` in the server output. Failed before the fix.
- **First SSR request** (`runFreshDevServer`, one `ssr` step, same URL): resolves, no throw. SSR answers
  a non-inline style with an empty module, so the client case checks the CSS text. Failed before the fix.
- **Restart** (`runFreshDevServer`): client main, client style, edit `rgb(120, 40, 160)` → `rgb(10, 20, 30)`,
  restart, client style: the new color, not the old. No watcher events, so plugin-vue's HMR cannot race the restart
  (HMR is 4.9). Failed before the fix (stale CSS), with the watcher ignoring every file too.
- **The record** (in-process `withDevServer` with a plugin counting transforms of the bare `Counter.ucf` id; each
  copy is a new path, so neither record knows it yet): the module, then its scoped and module style sub-requests,
  transform it once (3 times with no record); both style sub-requests first and together, once (twice before the
  shared warm-up).
- **Watch rebuild** (vite CLI `build --watch`, `NODE_ENV=production`): after the first build, a `<react>`-only edit;
  after the second: no error output, the CSS has `.counter[data-v-<id>]` with `<id> = scopeId(…, edited, true)`,
  different from the first build's, and the JS holds it too. A guard: it passed before the fix too.
- `packages/e2e/devx/peer-floor.spec.ts`: the vue floor read from the real manifest (plugin-vue 6.0.3,
  compiler-sfc and vue 3.5.15), and the refusals name both frameworks.
- `vue-floor` itself is the test of the floor: CI log lines showing the Vue tests ran there go in the PR message.

## Docs

- `docs/plan.md`, "Building on plugin-vue", item 3: names the exclude, the warm-up and the HMR `read` override (4.9);
  "Framework versions" gives the Vue ranges and why; milestone 4 names the `vue-floor` job.
- `publicdocs/01-getting-started.md`: the compiler-sfc range.
- `docs/milestones/m4-vue-target.md`: 4.7 Test line says the SSR and restart cases use a Node script (they need the
  server API); 4.7 names the `vue-floor` job it built and the two ranges it moved; `- Status: done`; 4.9 gains a line: its `read` override also
  records the source as handed (`handedToVue()`), so a hot update's sub-requests need no warm-up.
- `docs/milestones/README.md` "Test infrastructure": the floor row names `vue-floor` (M4, 4.7).
- `SETUP.md`: the `peer-floor` lines name the `vue-floor` job.
- `spec.md` and `architecture.md` cache-miss lines stay true.

## Out of scope

- The HMR `read` override (4.9), SSR rendering (4.8).
- Several dev servers in one process with different roots or modes sharing plugin-vue's cache: plugin-vue's own
  behaviour, the same for `.vue` files.

## Done when

- The four cases pass, the first three fail without the fix.
- `vue-floor` runs every test at the bottom of the vue peer ranges, green.
- `pnpm devx check` green; plan, milestone, README and SETUP docs updated; the todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
