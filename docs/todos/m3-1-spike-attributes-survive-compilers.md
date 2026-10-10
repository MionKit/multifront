---
type: chore
spec: full-plan
status: ready
created: 2026-10-10
milestone: 3
step: 3.1
---

# Milestone 3.1: spike, import attributes surviving each compiler

## Problem

Spec 4.4 moves `with { framework }` into the module id in a **post** `transform` (3.7). That only works if the
attribute is still on the import when post plugins get the code: after Vite's Oxc transform, plugin-react, plugin-vue's
script compile and the Svelte compiler. Three more facts later M3 steps rely on are unproven:

1. plugin-react applies Fast Refresh to an id ending in `?target=react&lang.tsx` (3.6 picks the plugin-react peer
   floor from it).
2. What Vite's dependency scanner does with `.ucf` imports (3.6 "During the dependency scan, follow the spike's
   verdict", 3.14 cold start test).
3. oxc-parser positions are UTF-16 offsets (3.5, 3.10).

Already seen in Vite 8.2.2 `dist/node/chunks/node.js` (the spike confirms each by running it):

- `:31530` `rolldownScanPlugin`: the scanner calls `pluginContainer.resolveId(id, importer, {scan: true})`.
- `:31691-31695`: a resolved relative id passing `isScannable` (`JS_TYPES_RE`, `:627`) is followed as
  `path.resolve(cleanUrl(resolved))`: the query is dropped, so `Card.ucf?target=react&lang.tsx` would be scanned as the
  raw `/abs/Card.ucf`. A bare `/abs/Card.ucf` is not scannable: external, its `<react>` bare imports never found.
- `:31488-31491` `prepareRolldownScanner`: plugins from `optimizeDeps.rolldownOptions.plugins` run **before** the scan
  plugins, so a `load` hook for `/\.ucf$/` there could serve the `<react>` block as `tsx`.

## Plan

### 1. Scratch spike (outside the repo, never committed)

`<scratchpad>/spike3/`, own `package.json` + `npm install` (no workspace lockfile change). Exact pins, all past the 30
day age (cutoff 2026-09-10): `vite` 8.2.2, `@vitejs/plugin-react` 6.1.1, `@vitejs/plugin-vue` 6.0.8, `vue` 3.5.42,
`svelte` 5.57.0, `@sveltejs/vite-plugin-svelte` 7.3.0, `react` / `react-dom` 19.3.0, `oxc-parser` 0.149.0,
`typescript` 6.0.3, `magic-string` 1.2.3. Node 26.11.1.

- `vite.config.ts`: `react()`, `vue()`, `svelte()`, then a recording post plugin: saves `{environment, mode, id,
  code}` for every importer, then strips `with` from imports of `./target.js` so builds finish.
- `target.js` (default + named export). Importers, each with the four forms carrying `with { framework: 'react' }`
  (static import, `export {x as y} from`, `export * from`, `import('./target.js', {with: {...}})`), every imported
  binding used (TS import elision is not attribute loss):
  - `a.ts`, `b.tsx`;
  - `C.vue`: `<script setup lang="ts">` with static + dynamic, the re-exports in a sibling `<script lang="ts">`;
  - `D.vue`: plain `<script>`, all four;
  - `E.svelte`: `<script lang="ts">` with static + dynamic, the re-exports in `<script module lang="ts">`;
  - `main.ts` imports all five (build entry).
- `run.mjs` prints importer x form x {dev client, dev SSR, client build, SSR build}: kept / dropped / error.
- Check 1: a scratch plugin resolves `./Card.ucf` to `/abs/Card.ucf?target=react&lang.tsx` and loads its `<react>`
  block. Pass = the dev client output has plugin-react's Fast Refresh code. Run on 6.1.1, 6.1.0, 6.0.5 and lower 6.0.x
  while it passes: the lowest passing version.
- Check 2: `index.html` → `main.tsx` → `./Card.ucf`, whose `<react>` block imports a bare dep nothing else imports. Cold
  dev start, real `optimizeDeps`. Per variant: what `resolveId` got (`options.scan`), whether the dep is in the first
  optimizer metadata or arrives later:
  - (a) `resolveId` returns the react id during the scan too;
  - (b) `resolveId` returns `{id, external: true}` when `options.scan`;
  - (c) (b) plus an `optimizeDeps.rolldownOptions.plugins` entry whose `load` serves the `<react>` block as `tsx`.
- Check 3: oxc-parser `parseSync('x.tsx', ...)` on a file with an emoji and accents before JSX. Pass = the element's
  `start` equals the JS (UTF-16) `indexOf`.

### 2. Workspace dependency

`@vitejs/plugin-react` 6.1.1 as an exact-pinned root devDependency (the canary needs it; test tools live at the root).

### 3. The canary (merged)

- Fixture `packages/e2e/fixtures/apps/attribute-canary/`: `vite.config.ts` (`plugins: [react()]`), `target.js`,
  `plain.ts`, `component.tsx` (the four forms, bindings used; `component.tsx` default-exports a component).
- `packages/e2e/build/attributes-survive.spec.ts` (area: build): `copyApp('attribute-canary')`, a real `createServer`
  (middleware mode, `ws: false`, `optimizeDeps.noDiscovery`) with the app's config plus an inline recording post plugin
  after `react()`. For both files, in the `client` and `ssr` environments, `transformRequest`, then parse the recorded
  code with Vite's `parseAst`:
  - exactly four import nodes of `./target.js` (`ImportDeclaration`, `ExportNamedDeclaration`,
    `ExportAllDeclaration`, `ImportExpression`), each with `framework: 'react'`;
  - plugin-react ran: the client code of `component.tsx` has its Fast Refresh marker.

### 4. Write the verdict

- `docs/plan.md` "Prototype first", item 3: "Answers" in item 1's style: versions, one bullet per compiler, one per
  check with evidence, the decision for each "no".
- `docs/milestones/m3-react-and-imports.md`: 3.1 `- Status: done`; 3.6 plugin-react floor and the concrete scan
  bullet; 3.7 plugin-react already at the root; the Risks "The dependency scanner" bullet; 3.5 / 3.10 / 3.14 only if a
  check fails.
- Only for a "drops it" / "cannot parse" result: spec 4.4 + architecture "Build" (Oxc), the M4 step (plugin-vue), the
  M6 step (Svelte), spec 4.2's note (cannot parse).
- Oxc drops it → stop and ask before writing the canary.

## Decisions

- Check 2: if variant (c) works, it is 3.6's scan approach; else (b), with the conflict with 3.14's cold start test
  named in the verdict (orchestrator: 3.14's Test line is the binding outcome).

## Tests

- Spike: `run.mjs` on this host only, nothing merged; the PR quotes its tables.
- Canary: `packages/e2e/build/attributes-survive.spec.ts`, on this host and in CI's `check` job
  (`pnpm devx test --reporter verbose`), no new infra. The PR quotes the CI log lines showing it ran.
- Gate: `pnpm devx check`.

## Docs

As in plan step 4. No publicdocs page covers this.

## Fuzzing

None: a fixed guard over fixed forms.

## Out of scope

- Any `@multifront/vite` or core code (3.2, 3.6, 3.7), the scan handling itself (3.6), the cold start test (3.14).
- Canary rows for plugin-vue (M4) and Svelte (M6).
- `react-dom`, `@types/react-dom` root devDependencies (3.7).

## Done when

- `docs/plan.md` item 3 holds the verdict with run evidence; each failing check has its listed change applied.
- The canary passes locally and in CI, and the CI log shows it ran.
- 3.1 ends with `- Status: done`; `pnpm devx check` passes; this todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
