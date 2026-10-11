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
- `vite build --watch` then a `<react>` edit: rebuilds fine today, CSS and JS carry the new production scope id. A guard.

## Decisions

- Orchestrator, Q1: build the `vue-floor` CI job in this step, own commits. M3's hands say "milestone 4 adds
  `vue-floor`", no M4 step owns it, M4 Risks rely on "the CI matrix of supported plugin-vue versions", and the
  milestones README says the step whose test first needs a piece builds it. 4.7 is the first remaining step whose test
  depends on plugin-vue internals. A real failure at the floor gets fixed here (own commit, own test).
- Orchestrator, Q2: the record is keyed on the source only, as the step text says. A production build then a dev
  server in one process, or two roots, hit plugin-vue's module-level cache the same way for `.vue` files.
- Orchestrator: no fuzz test.

## Plan

1. `packages/vite/src/vueTarget.ts`:
   - module-level `handedSources = new Map<string, string>()`: file → the `.ucf` source whose SFC code plugin-vue last
     got from us. Module level: the same lifetime as plugin-vue's cache (one process, across restarts and plugin
     instances).
   - `handedToVue(file, source)`: records it.
   - `warmUpVue(context, file, source)`: if `handedSources.get(file) !== source`, `await context.load({id: file})`.
     That runs our load + transform and plugin-vue's `transformMain`, which fills its cache. A file never handed
     (fresh process) or changed on disk since (restart) gets warmed. An error in the main transform becomes the
     sub-request's error, naming the right `.ucf` line.
2. `packages/vite/src/index.ts`, the pre plugin:
   - `load`: after the `server.fs.allow` check (a denied file is never warmed), for `query.has('vue')` on a `.ucf`
     path, `await warmUpVue(this, path, (await cache.splitUcf(path)).source)` and return `undefined`: plugin-vue loads
     the sub-request from a warm cache.
   - `transform`: `handedToVue(id, version.source)` after `built()` succeeds.
   - Builds never warm up: a sub-request loads only after its main module transformed, so the record matches.
3. The `vue-floor` CI job:
   - `scripts/lib/peer-floor.mjs`: a `vue` row in `FLOOR_PEERS`: peers `@vitejs/plugin-vue` and `@vue/compiler-sfc`,
     and `vue` taking the `@vue/compiler-sfc` floor (`vue` pins its own compiler-sfc exactly, so the two move together).
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
   - The full suite passes at the floor (plugin-vue 6.0.3, compiler-sfc and vue 3.5.15): 2173 tests.

## Tests

`packages/e2e/build/vue-cache-miss.spec.ts`, run by `pnpm devx test` on this host and in CI's `check`, `react-floor` and
`vue-floor` jobs. No new CI infra beyond `vue-floor`: child processes, as the editor tests use. Each case is a fresh
process with its own `copyApp('vue')`, removed after. Expected scope ids come from core's
`scopeId(rootRelativePath(root, file), source, production)`.

Helper `packages/e2e/build/lib/freshProcess.ts`:

- `startViteCli(root, args, env)`: spawns `node --conditions=source <vite>/bin/vite.js …args` in `root`, with
  `NO_COLOR=1`; `waitForOutput(pattern, count)`, `output()`, `stop()`.
- `runFreshDevServer(root, steps, {watch})`: spawns `node --conditions=source` on the same file
  (`import.meta.main`), which runs `{env, request}`, `{edit: {file, from, to}}` and `{restart: true}` steps on one
  `createServer()` (`configLoader: 'native'`, middleware mode, no dep discovery) and prints each request's code as
  JSON. `server.watch: null` goes straight to `createServer` (Vite's `mergeConfig` drops nulls).

Cases:

- **First dev request** (vite CLI, `--configLoader native --port 0`, `NODE_ENV=development`): fetch the
  `type=style&index=0&scoped=<id>&lang.css` URL of `Counter.ucf` first. 200, its `__vite__css` holds
  `.counter[data-v-<dev id>]` with `rgb(120, 40, 160)`, no `/error/i` in the server output. Fails today.
- **First SSR request** (`runFreshDevServer`, one `ssr` step, same URL): resolves, no throw. Fails today. SSR answers
  a non-inline style with an empty module, so the client case checks the CSS text.
- **Restart** (`runFreshDevServer`, watcher off): client main, client style, edit `rgb(120, 40, 160)` →
  `rgb(10, 20, 30)`, restart, client style: the new color, not the old. Watcher off so plugin-vue's HMR cannot race
  the restart (HMR is 4.9). Fails today (stale CSS).
- **Watch rebuild** (vite CLI `build --watch`, `NODE_ENV=production`): after the first build, a `<react>`-only edit;
  after the second: no error output, the CSS has `.counter[data-v-<id>]` with `<id> = scopeId(…, edited, true)`,
  different from the first build's, and the JS holds it too. Guard: passes today.
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
