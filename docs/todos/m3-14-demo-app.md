---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 3
step: 3.14
---

# Milestone 3.14: Demo app

## Problem

No app exercises the React path as a user would: a real `App.tsx` rendering several `.ucf` components together, a
shared component with state, a scoped and a module style, a parent scoped style reaching a child root, and a `.ucf`
import with `with { framework }` from a `.ts` file. The exit test (3.16), the HMR test (3.15) and milestone 4
("same demo renders both") build on this app. Nothing checks yet that a cold dev start pre-bundles every dependency
up front (spike check 2: a broken scan reloads the page after the first load).

## Plan

### 1. Shared fixture `packages/e2e/fixtures/components/Counter.ucf`

Top level, shared (M4 fills its `<vue>` block for real, M6 adds `<svelte>`):

- `<vue>`: a template-only stub, `<template><div class="counter"><span class="label">Clicks</span></div></template>`.
  Real and non-empty, never built in M3; 3.15 edits it (a `<vue>` edit sends no request).
- `<react>`: `import {useState} from 'react'`, then `export default function Counter({start = 0}: {start?: number})`
  with `useState(start)`: root `<div className="counter">`, a text label `<span className="label">Clicks</span>`
  (3.15 edits this text), `<button className={$style.button} onClick={() => setCount(count + 1)}>{count}</button>`.
- `<style scoped>`: `.counter { color: rgb(120, 40, 160); }` (3.15 and the exit test edit this declaration).
- `<style module>`: `.button { padding: 4px 12px; }` (`$style`).

A new top-level fixture feeds the tests that list every top-level fixture (README: the milestone that adds a fixture
updates the snapshots it feeds):

- `packages/core/test/split.spec.ts`: `'Counter.ucf'` in the "finds every valid fixture" list.
- `packages/core/test/context.spec.ts`: `FIXTURES` gets `'Counter.ucf': {hasScoped: true, modules: {$style: 1}}`.
- `packages/core/test/react/scope.spec.ts`: `SCOPED` gets `{fixture: 'Counter.ucf'}` (`<react>`, scoped style, clean
  check: the "runs every fixture" check requires the row).
- The new file snapshots the per-fixture loops write for Counter, made by a local run, read, committed. Any other
  exact list that breaks gets the new row.

### 2. App `packages/e2e/fixtures/apps/demo/`

- `index.html`: as `react-basic` (`#app`, `<link rel="icon" href="data:," />` so no favicon 404, `/src/main.tsx`).
- `vite.config.ts`: `defineConfig({plugins: [react(), multifront()]})`, no options (a user's first app).
- `src/main.tsx`: `createRoot(document.getElementById('app')!).render(<StrictMode><App /></StrictMode>)`.
- `src/App.tsx`: one `<section data-demo="…">` per part, so tests (and M4's Vue island beside them) find each:
  - `data-demo="counter"`: `<Counter />`, bare from `../../../components/Counter.ucf`;
  - `data-demo="panel"`: `<ScopedPanel />` from `../../../components/react/ScopedPanel.ucf` (renders ScopedBadge);
  - `data-demo="card"`: `<Card title="Bare import" />`, bare from `../../../components/Card.ucf` (importer rule:
    `.tsx` picks react), and `<HelperCard title="From the .ts helper" />` from `./card.ts`.
- `src/card.ts`: `import Card from '../../../components/Card.ucf' with { framework: 'react' }; export default Card;`
  (a `.ts` importer has no default target: only the attribute picks react).

### 3. `startDev` takes a logger

- `packages/e2e/browser/lib/serve.ts`: `startDev(appDir, {logger}: {logger?: Logger} = {})` passes
  `customLogger: logger` to `createServer` (Vite uses a custom logger as given, whatever `logLevel` says). The only
  way to see the optimizer's "dependencies optimized" / "optimized dependencies changed. reloading" lines. Existing
  callers unchanged; the 3.9 build line in the milestone doc shows the new shape.

### 4. Test `packages/e2e/browser/demo.spec.ts` (area: browser)

One `launchChromium()` per file. `describe.each` over `['dev', startDev]` and `['preview', buildAndPreview]` on the
fixture app (no edits, no `copyApp`):

- **Renders all three, with their styles, no console error:** wait for the Counter button, then a table of hand-read
  computed values, one named row each:
  - Counter root `.counter` `color` `rgb(120, 40, 160)` (scoped); Counter button `padding` `4px 12px` (`$style`);
  - ScopedPanel `.panel` `padding` `8px`; ScopedBadge root span `color` `rgb(30, 120, 60)` (parent's scoped
    `.badge` through forwarding); its inner `em.badge-label` `text-decoration-line` `none`;
  - both Cards' root `div` `padding` `16px` (`$style.card`, scss), and their `h2` texts.
  - After `networkidle`: no `warning`, `error` or `pageerror` from `collectConsole`.
  - Saves every `#app *` element (tag, text of a leaf, `color`, `padding`, `text-decoration-line`, `font-size`)
    for the comparison below.
- **Dev and preview match:** a following `it` checks both saved lists exist and are equal.

Separate describe, **cold start**: `startDev(ROOT, {logger})` (its own fresh `cacheDir`, the same as an empty
`node_modules/.vite`); the logger records every info, warn and error line. Open the page, count `load` events, wait
for the Counter, `networkidle`, `server.environments.client.waitForRequestsIdle()`, poll until
`depsOptimizer.metadata.discovered` is empty (first optimize run committed), wait 500 ms (Vite logs a rerun's
"dependencies optimized" 200 ms later). Expect one `load` event, no warn or error line, no info line matching
`/optimiz|reload/`. A broken scan (lost `multifront:scan`, a `.ucf` import failing during it) finds
`react-dom/client` late and reloads: this test catches it.

Runs on this host (Chromium from `MULTIFRONT_CHROMIUM_PATH`) and in CI `check` and `react-floor` (Chromium there
since 3.9). No new infra beyond the `startDev` logger option.

## Decisions

- Counter's `<vue>` block is a template-only stub: the real Vue counter is M4's work (orchestrator).
- No Counter click in this step's test: the step asks for render, styles, console and cold start only (orchestrator).
- Cold start guards the scan through `react-dom/client`, no block-only dependency added (orchestrator).

## Docs

- `docs/milestones/m3-react-and-imports.md`: `- Status: done` on 3.14; the 3.9 `startDev` line shows `{logger}`.
- `docs/spec.md`, `docs/plan.md`, `docs/architecture.md`: none (no design change). `publicdocs/`: none (the
  milestone's docs writer).

## Fuzzing

None: the step names no fuzz test, and a demo app has no cheap oracle.

## Out of scope

- HMR (3.15), the exit test and its SSR render (3.16), the Vue island (M4), Counter's `<svelte>` block (M6).

## Done when

- `packages/e2e/browser/demo.spec.ts` passes locally (dev, preview, comparison, cold start) and in CI `check` and
  `react-floor`.
- The core and editor tests that list every fixture pass with Counter's rows and snapshots.
- `pnpm devx check` green; this spec moved to `docs/done/`, matching what shipped; 3.14 is `- Status: done`.
- The simplify-comments pass ran on every touched source file, committed on its own.
