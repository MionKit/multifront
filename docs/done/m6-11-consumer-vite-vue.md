---
type: feature
spec: full-plan
status: done
created: 2026-10-13
milestone: 6
step: 6.11
---

# Milestone 6.11: consumer, a fresh Vite Vue app

## Problem

6.10 installs the packed React package into a fresh Vite React app; nothing installs `@mf-fixture/ui-vue` yet. The
consumer area already has everything this step needs (`createConsumerApp`, `runInApp`, `serveApp`, `freePort`,
`openPage`, `fixtureTarballs`), and CI's `consumer-pack` + `consumer` jobs. Missing: a Vue template and its spec.

Checked on this host with a throwaway app (repo install policy, the real `@mf-fixture/ui-vue-1.2.3.tgz`):

- `pnpm install` + `pnpm add <tgz>` work. `vue-tsc --noEmit` passes with `<!-- @vue-expect-error -->` on
  `<Card titel="x" />`; without it, TS2345 "Property 'title' is missing": the shipped `Card.d.ts` is used.
- `vite build --sourcemap --manifest` with inputs `{main: 'index.html', styles: 'styles.html'}` builds. `styles`' CSS
  holds `.badge[data-v-…]`, `.counter[data-v-…]`, `.vue-only[data-v-…]` though that page imports only `Card`: they
  come from `styles.css` alone. `main`'s CSS has no `.badge`.
- `vite preview` + Chromium under 6.10's CSP (`default-src 'self'; style-src 'self'`): Card padding `16px`, color
  `rgb(30, 60, 90)`, title `rgb(150, 40, 60)`, root attribute `data-v-d20878a2`; Counter `Count 0` → `Count 1`,
  color `rgb(120, 40, 160)`; Button classes `button_<hash> extra`, color `rgb(255, 0, 0)`, weight `600`, a click
  emits `click` with a `MouseEvent`; VueOnly (by subpath `@mf-fixture/ui-vue/VueOnly`) padding `4px`. Zero console
  messages on both pages.
- React's `Card.js` stamps the same `data-v-d20878a2`: both equal core's `scopeId('src/Card.ucf', source, true)`.

## Plan

1. **Template** `packages/e2e/fixtures/apps/consumer-vite-vue/`, no multifront package:
   - `package.json`: `vue` 3.5.42; dev `vite` 8.2.2, `@vitejs/plugin-vue` 6.0.8, `vue-tsc` 3.3.11, `typescript`
     6.0.3 (the root's pins).
   - `index.html` and `styles.html` with 6.10's CSP meta and `/favicon.svg`; `public/favicon.svg` (6.10's copy);
     `tsconfig.json` (6.10's settings, no `jsx`); `vite.config.ts` with `vue()` and inputs `main` (`index.html`) and
     `styles` (`styles.html`).
   - `src/main.ts` mounts `src/App.vue`: `Card` holding `Counter`, `Button` with `class="extra"`,
     `:style="{color: 'red'}"` and `@click` (counts into `#clicks` when given a `MouseEvent`), `VueOnly`. All from
     `@mf-fixture/ui-vue`; `VueOnly` from its subpath (the index exports only components with every framework's block).
   - `src/styles.ts` imports `@mf-fixture/ui-vue/styles.css` and renders only `Card` (a render function): the page
     taking the combined file instead of relying on per-component CSS.
   - `src/Checks.vue`: the wrong prop under `<!-- @vue-expect-error -->`, type checked only, never bundled.
2. **Shared consumer helpers** in `packages/e2e/consumer/lib/app.ts`, used by both Vite specs:
   - `serveConsumerApp({target, template, build, serve})`: the spec's `beforeAll` / `afterAll` (tarball, install,
     build, serve, teardown in order), returning a getter for `{app, url, build}`.
   - `expectStyledCard(page)`: Card's computed padding, color, title color, and the root's scope attribute from
     `browser/lib/scope.ts`'s `scopeAttribute(LIBRARY_DIR, <src/Card.ucf>, true)` (core's `scopeId`).
   - `expectCspEnforced(url)`: the 6.10 CSP canary.
   - `readDist(app, file)` and `manifestGraph(app, entry)`, moved from `vite-react.spec.ts`.
3. **React side**: `packages/e2e/consumer/vite-react.spec.ts` moves onto these helpers, so its Card check now asserts
   the scope attribute too: the Vue and React attributes are pinned to one value.
4. **CI**: the three floor jobs (`.github/workflows/ci.yml:76`, `:97`, `:118`) also `--exclude
   'consumer/vite-vue.spec.ts'` (fresh apps pin their own framework versions). The `consumer` job already runs the
   folder; its store cache key already hashes `consumer-*/package.json`.

## Decisions

- Keep 6.10's CSP and its canary test in the Vue app. (Orchestrator.)
- The styles page imports `styles.css` and only `Card`; the proof is that rules of components it never imports reach
  it. (Orchestrator.)
- Both apps' Card attribute checked against core's `scopeId`, not against each other. (Orchestrator.)
- No fuzz test. (Orchestrator.)
- Review: reuse `browser/lib/scope.ts`'s `scopeAttribute` instead of a second one; share the setup, the Card check and
  the CSP canary between the specs; the styles page renders Card itself; the Vue build skips `--sourcemap` (nothing
  reads the maps).

## Tests

`packages/e2e/consumer/vite-vue.spec.ts`. Setup through `serveConsumerApp`: `fixtureTarballs()`,
`createConsumerApp('consumer-vite-vue', [vue tarball])`, `vite build --manifest`, `vite preview` (240 s setup
timeout). Checks:

- the app holds `@mf-fixture/ui-vue` and no `@multifront` package.
- `vue-tsc --noEmit --pretty false` prints nothing, exits 0 (an unused `@vue-expect-error` would fail too).
- `vite build` passes.
- main page: Card computed padding, color, title color; Card root has Card's scope attribute (`expectStyledCard`); Counter
  `Count 0` → `Count 1`; Button both classes, red, weight 600, a click sets `#clicks` to 1; VueOnly padding `4px`; no
  console error or warning, page error or CSP violation (`consoleProblems`).
- CSP canary: an injected inline style is refused and reported.
- styles page: its manifest CSS holds `.counter`, `.vue-only`, `.badge` rules (components it never imports), `main`'s
  holds no `.badge`; in Chromium Card is styled the same, no console problem.
- `vite-react.spec.ts`: Card's root carries the same attribute (`expectStyledCard`).

Where: this host (registry reachable, Chromium via `.env`), and CI's `consumer` job. No new infra.

## Docs

- Milestone doc 6.11: `- Status: done`, shipped shapes (styles page, shared helpers); "Hands to later milestones"
  consumer line names `serveConsumerApp`, `expectStyledCard`, `expectCspEnforced`, `readDist`, `manifestGraph`.
- `docs/milestones/README.md` Consumer row already says the floor jobs leave out the fresh-app specs: no change.
  SETUP.md, spec: no change.

## Fuzzing

None: no cheap oracle, the feature is one install path.

## Out of scope

- 6.12, 6.13, the exit test; Vue SSR in a consumer; a local registry.

## Done when

- `vite-vue.spec.ts` and the extended `vite-react.spec.ts` pass here and in CI's `consumer` job, its log showing
  them running. `pnpm devx check` passes.
- Docs updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
