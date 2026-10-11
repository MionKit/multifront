---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.11
---

# Milestone 4.11: One app, both targets

## Problem

Spec section 9, milestone 4: "same demo renders both". The demo app (`packages/e2e/fixtures/apps/demo/`) renders
`Counter.ucf` only as React (`src/App.tsx`), and its `vite.config.ts` has no plugin-vue. M4's exit test (4.15) and M6
(the Svelte counter in the same parity test) need a demo that mounts the same file as React and as Vue, and a
computed-style comparison helper.

Checked on this host with an in-memory build (`[react(), vue(), multifront()]`, a virtual `mountVue.ts`): the build is
one chunk; `Counter.ucf.react.tsx` imports `react/jsx-runtime` and holds no Vue helper; the Vue modules (bare
`Counter.ucf`, `?vue&type=script&setup=true&lang.ts`) import `vue` and hold no `jsx`; no `framework` text is left;
Counter's two CSS rules ship twice (spec 4.3, "CSS twice in a mixed app", accepted).

## Decisions

- Orchestrator: plan approved.
- Orchestrator, Q1: the M3 exit test's CSS check becomes an exact count per file, 2 for `Counter.ucf` and 1 for the
  rest (spec 4.3 accepts the duplicate).
- Orchestrator, Q2: `hmr-react.spec.ts` stays on the demo, with stricter mixed-page expectations.
- Orchestrator, Q3: no fuzz test.
- Orchestrator: the 4.11 step text follows what shipped (real import path, the `mountVue.ts` island, modules not chunks).
- Review (automatic triage), all fixed: `mixed-targets.spec.ts` drops the `framework` text check `demo-exit.spec.ts`
  already runs on the same build, keeps `expectNoAttribute()` (the step's Test line), checks every module id of the
  build for `framework=` (not only Counter's) and the Vue code for `createElementBlock`; `mountVue.ts` mounts on import
  (no one-caller wrapper); `STYLED` is an object; no redundant sort or spread.
- Found: `build/vue-cache-miss.spec.ts` timed out once in a full gate run; filed as a guidelines todo in this PR.

## Plan

1. **Demo app gains a Vue island**:
   - `vite.config.ts`: `plugins: [react(), vue(), multifront()]`.
   - New `src/mountVue.ts`: imports `Counter` from `'../../../components/Counter.ucf' with {framework: 'vue'}` (a `.ts`
     importer has no default framework) and runs `createApp(Counter).mount('#vue')`. 4.13 runs quick info on
     `Counter` here.
   - `index.html`: `<div id="vue"></div>` after `<div id="app"></div>`.
   - `src/main.tsx`: `import './mountVue.ts';`.
   - `entry-server.tsx` stays React only.
2. **New helper `packages/e2e/browser/lib/parity.ts`**:
   `expectSameComputedStyles(first: Locator, second: Locator, properties: string[]): Promise<void>` reads each
   property on both through `computed()` into a `{property: value}` record and expects them equal.
3. **Existing demo tests the island changes**:
   - `build/hmr.spec.ts`: `hmrApp()` builds with `configFile: false` and `[react(), multifront(), ...plugins(), recorder]`,
     so the "without plugin-vue" describe has none and the others hold one plugin-vue, as today.
   - `browser/hmr-react.spec.ts`: a `<style scoped>` edit requests our style module and plugin-vue's
     `?vue&type=style&index=0&scoped=<scope id>&lang.css`; a `<react>` edit only `.react.tsx`; a `<vue>` edit only
     `/@fs<Counter.ucf>?import` (the Vue module `mountVue.ts` imports), the Vue label changes, the React counter keeps
     3 and `Taps`.
   - `browser/demo-exit.spec.ts`: CSS count per file: 2 for `Counter.ucf`, 1 for `react/ScopedPanel.ucf` and `Card.ucf`.

## Tests

All under `pnpm devx test`, on this host and in CI's `check`, `react-floor` and `vue-floor` jobs (Chromium installed
since M3 3.9; in-process `buildApp`, `startDev`, `buildAndPreview`). No new infra.

- `packages/e2e/build/mixed-targets.spec.ts`: one production `buildApp()` of the demo with a spy plugin recording
  `importedIds` of every `Counter.ucf` module in `generateBundle`.
  - React module: imports `react/jsx-runtime`, nothing from `vue`; rendered code holds `jsx`, no
    `openBlock` / `createElementBlock` / `createElementVNode`.
  - Vue modules (bare + `?vue&…`): import neither `react` nor `react/jsx-runtime`; rendered code holds
    `createElementBlock`, no `jsx`.
  - `expectNoAttribute()` on every chunk, and no module id of the build with `framework=`. The `framework` text check
    on every output file stays in `demo-exit.spec.ts`, on the same build.
- `packages/e2e/browser/parity.spec.ts`, dev and preview: both counters render (`#app [data-demo="counter"] > .counter`,
  `#vue > .counter`) with the same `data-v-*`, equal to `scopeAttribute()`; `expectSameComputedStyles()` on padding,
  color, font size and border for root, `.label` and button, with hand-read values on one side; clicking each counter
  changes only its own count; no console warning or error.
- The updated `build/hmr.spec.ts`, `browser/hmr-react.spec.ts`, `browser/demo-exit.spec.ts`.

## Docs

- `docs/milestones/m4-vue-target.md` 4.11: real import path, `mountVue.ts` imported by `main.tsx`, mounting on the `#vue`
  container, "modules" in place of "chunk", `- Status: done`.
- `spec.md`, `plan.md`, `architecture.md`, `publicdocs/`: none (fixture and tests only).

## Fuzzing

None: no cheap oracle for a fixed demo app.

## Out of scope

- The milestone exit test (4.15), Vue SSR of the demo, deduping the mixed app's CSS.
- Editor tests on `mountVue.ts` (4.13).

## Done when

- `mixed-targets.spec.ts`, `parity.spec.ts` and the three updated demo specs pass here and in CI; `pnpm devx check` green.
- Milestone doc updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
