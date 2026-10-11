---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 3
step: 3.16
---

# Milestone 3.16: Exit test and the go / no-go verdict

## Problem

Milestone 3 must end with one test that proves the React path as a whole, on the demo app: render, Fast Refresh
keeping state over several `<react>` edits, a style-only edit, a parent scoped style on a child root, build + preview,
and SSR. Then the go / no-go call against the five go criteria in the milestone doc, written down with evidence in
`docs/plan.md`. Nothing records the verdict today; the fuzz long run (3.13) has not run yet.

## Plan

### 1. SSR entry in the demo: `packages/e2e/fixtures/apps/demo/src/entry-server.tsx`

```tsx
import {renderToString} from 'react-dom/server';
import App from './App.tsx';

export function render(): string {
  return renderToString(<App />);
}
```

Same shape as `fixtures/apps/imports/no-default/ssr-entry.tsx`. It renders the whole demo, so the SSR HTML holds both
Cards (bare and through `card.ts`'s `with { framework: 'react' }`), ScopedPanel and ScopedBadge. Not in
`index.html`, so the client build and `demo.spec.ts` do not see it. The other demo users (`hmr-react.spec.ts`,
`build/hmr.spec.ts`) copy the app and never load it.

### 2. Shared test helpers (no duplicate of the HMR and attribute code)

- `packages/e2e/browser/lib/requests.ts`: `trackRequests(page: Page): RequestLog`, moved out of
  `hmr-react.spec.ts` (which then uses it, behaviour unchanged):
  - `paths(): string[]`: path + query of each request since `clear()`, Vite's `t=` dropped;
  - `clear(): void`;
  - `quiet(ms: number, since?: number): Promise<void>`: no request in flight and no activity for `ms`, counting
    from `since` too (the `<vue>` case's "window counts from the change event").
- `packages/e2e/browser/lib/chromium.ts`: `renderedStyles(page, properties)`: every `#app *` element as
  `{tag, text (leaf only), styles}`, moved out of `demo.spec.ts` (which then uses it).
- `packages/e2e/build/lib/references.ts`: `moduleReferences(code)` (every import / re-export / `import()` /
  `__vite_ssr_import__` with its attribute or option keys) and `expectNoAttribute(code)`, moved out of
  `build/imports.spec.ts` (which then imports them). `keyName` stays in `build.ts`.

### 3. The exit test: `packages/e2e/browser/demo-exit.spec.ts` (area: browser)

`beforeAll`: `launchChromium()`, `copyApp('demo')`, `startDev(copy)`, one page with `collectConsole`, a `load`
counter and `trackRequests`. `afterAll` closes all, `removeApp`. One `describe`, tests in order (they share the page):

1. **Renders all three, `$style` applies:** Counter button reads `0`; badge label `new`; Card `h2`s
   `['Bare import', 'From the .ts helper']`. Computed: Counter button `padding` `4px 12px` (`$style.button`), both
   Card roots `padding` `16px` (`$style.card`, scss), Counter `.counter` `color` `rgb(120, 40, 160)` (scoped).
   Saves `renderedStyles` (before any edit) for item 7.
2. **Scoped style reaches the child root (exit item 4):** ScopedBadge's root span (`.panel > span`) carries
   ScopedPanel's `data-v-<id>` (oracle: core `scopeId(relative path from root, source, false)`, as
   `react-scope.spec.ts`), computed `color` `rgb(30, 120, 60)`; its inner `em.badge-label` carries no such attribute,
   `text-decoration-line` `none`.
3. **Fast Refresh, three `<react>` edits (exit item 2):** click Counter to 3; edit the label text `Clicks` → `Taps`
   → `Hits` → `Presses`, each: poll the new text, `quiet(500)` (watcher throttle), count still `3`, `load` count `1`.
4. **Style-only edit (exit item 3):** `rgb(120, 40, 160)` → `rgb(10, 20, 30)` in `<style scoped>`: poll computed
   color, count `3`, no requested path ends in `.ucf.react.tsx`, the style module
   (`/@fs<Counter.ucf>?ucf&type=style&index=0&lang.css`) was requested.
5. **No warning:** `load` count `1`, no `warning` / `error` / `pageerror` over the whole dev session.
6. **SSR (exit item 6):** `server.environments.ssr` (`isRunnableDevEnvironment`), `runner.import('/src/entry-server.tsx')`,
   `render()`. The HTML goes into a fresh Chromium page (`setContent`, real HTML parsing): both Card `h2`s are
   there; `.panel > span` carries ScopedPanel's dev `data-v-<id>`, `.badge-label` does not.
7. **Build + preview (exit item 5):** `buildAndPreview` of the pristine fixture (the copy is edited by now; same
   relative paths, so the same scope ids):
   - preview page: `renderedStyles` equals item 1's dev list;
   - every file under `outDir` (html, js, css): no `framework` text anywhere (today's output has none), and every
     `.js` through `expectNoAttribute` (a text check on `with` would hit React's "object with keys {");
   - CSS: for Counter.ucf, react/ScopedPanel.ucf and Card.ucf, `createBuildContext(..., {production: true})` gives
     each style block; its selector appears exactly once across the CSS files (the `react-target.spec.ts` way);
     4 style blocks in all.

Runs on this host (Chromium found) and in CI `check` and `react-floor` (Chromium since 3.9, `pnpm devx test` runs
every e2e file). No new infra.

### 4. Evidence runs (before the verdict)

- Exit test 20 times in a row locally: a shell loop of `pnpm devx test packages/e2e/browser/demo-exit.spec.ts`,
  stops at the first failure.
- Fuzz long run: `MULTIFRONT_FUZZ_SEED=<s> MULTIFRONT_FUZZ_RUNS=10000 pnpm devx test packages/e2e/build/scope-fuzz.spec.ts`
  for seeds 1 to 10 (CI keeps 2026).
- Full `pnpm devx check`.
- Any failure: fixed in this PR if it is a bug of this step's tests; a failure of the transform or of a go
  criterion → `QUESTION` to the orchestrator with the evidence before any verdict is written.

### 5. The verdict: `docs/plan.md`, "### 3. React target and imports (go / no-go)"

A `**Verdict**` paragraph (versions tested, top and floor of the React range), go or no-go, then one line per go
criterion:

1. exit test: green in `check` and `react-floor` (the PR's CI run link, added once that run is green), 20 / 20 local
   runs;
2. shapes: `browser/react-scope.spec.ts` in dev and preview (every forwarded shape and branch carries the parent's
   id on its root only, FragmentRoot and NullRoot none, only the expected dev fragment warning; a shape's own stamp
   where it has a scoped style);
3. fuzz: 10 seeds × 10,000 files, seeds listed, no failure, transform untouched;
4. style-only edit: exit item 3 + `hmr-react.spec.ts`;
5. no attribute left: `build/imports.spec.ts` (dev, build, SSR), `editor/imports.spec.ts` (build and tsserver agree),
   exit item 5.

On go: no fallback todos. (No-go would file one todo per fallback step; only via a `QUESTION` first, see 4.)

## Decisions

- Go criterion 2's "its own `data-v-<id>`" holds where the shape has a scoped style, as Vue stamps only then and
  3.10 copied it; the m3 doc's criterion says so (orchestrator).
- Exit item 6 renders the demo's whole `App` through `src/entry-server.tsx`, checking the Card and the badge
  (orchestrator).
- The verdict first cites local evidence; one docs commit adds the CI run link once `check` and `react-floor` are
  green, before merge (orchestrator).
- The request log, the computed styles list and the attribute check move into `<area>/lib/` (orchestrator).
- Fuzz long run seeds: 1 to 10 (orchestrator).

## Docs

- `docs/plan.md`: the verdict (above).
- `docs/milestones/m3-react-and-imports.md`: `- Status: done` on 3.16; exit test item 6 reads "the demo's `App`
  (`src/entry-server.tsx`)" instead of "the same Card"; go criterion 2 reads "its own `data-v-<id>` on every host
  element when it has a scoped style"; "Hands to later milestones": `trackRequests` and `renderedStyles` join the
  `browser/lib/` line, `fixtures/apps/demo/` names `src/entry-server.tsx`.
- `docs/spec.md`, `docs/architecture.md`: none (no design change). `publicdocs/`: none (the milestone's docs writer).

## Fuzzing

No new fuzz test: this step runs 3.13's long run. The exit test has no cheap random oracle.

## Out of scope

- Any change to the scope transform, the plugin or core (go criterion 3: "no change to the transform after it").
- Vue / Svelte targets, hydration and visual parity (milestone 4 on).

## Done when

- `demo-exit.spec.ts` passes locally 20 times in a row and in CI `check` and `react-floor` (log lines quoted).
- The fuzz long run (10 seeds × 10,000) is green; `pnpm devx check` green.
- `docs/plan.md` holds the verdict with its evidence; 3.16 is `- Status: done`; this spec moved to `docs/done/`,
  matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
