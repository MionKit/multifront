---
type: feature
spec: full-plan
status: done
created: 2026-10-13
milestone: 6
step: 6.13
---

# Milestone 6.13: consumer, a fresh SvelteKit app

## Problem

6.10, 6.11 and 6.12 install the packed React and Vue packages into fresh apps. Nothing installs the packed Svelte
package (`@mf-fixture/ui-svelte`, uncompiled `.svelte` files from 6.8) into a real SvelteKit app, type checks it with
`svelte-check`, server renders it and hydrates it. The consumer area already has what this needs (`serveConsumerApp`,
`createConsumerApp`, `runInApp`, `serveApp`, `freePort`, `openPage`, `expectStyledCard`) and CI's `consumer-pack` and
`consumer` jobs. Missing: a SvelteKit template, its spec, and one table for "the same computed styles as 6.10's React
consumer".

Checked on this host with a throwaway app (the repo's install policy, the real `mf-fixture-ui-svelte-1.2.3.tgz` from
`pnpm devx consumer-pack`):

- The root pins install under the policy: `@sveltejs/kit` 2.70.3, `@sveltejs/adapter-node` 5.5.7,
  `@sveltejs/vite-plugin-svelte` 7.3.0, `svelte` 5.57.0, `svelte-check` 4.7.6, `typescript` 6.0.3, `vite` 8.2.2.
  Kit's peers (`vite ^8`, plugin-svelte `^7`, `typescript ^6`) fit.
- `svelte-kit sync` then `svelte-check --tsconfig ./tsconfig.json --fail-on-warnings --output machine`:
  `0 ERRORS 0 WARNINGS`, exit 0. With a page rendering `<Card titel="x" />`: exit 1, one
  `ERROR "src/routes/wrong/+page.svelte" 5:7 "... '"titel"' does not exist in type '$$ComponentProps'."`.
  `--tsconfig` limits the check to the files the tsconfig includes. `pnpm install` runs no `prepare` script
  (`ignoreScripts`), so the spec runs `svelte-kit sync` itself.
- `vite build` (adapter-node) passes; `PORT=<n> node build` serves it. The server HTML holds
  `<article data-v-d20878a2="" class="card_d20878a2_0 card">`, `<button data-v-5386425a="" class="counter">`,
  `<link href="./_app/immutable/assets/2.<hash>.css" rel="stylesheet">` and no `<style>`.
- Chromium, once hydrated: Counter goes to `Count 1` on a click, Button's `onclick` fires, no console message.
  Computed: Card root `16px` / `rgb(30, 60, 90)` / `8px` / `16px`; title `0px 0px 8px` / `rgb(150, 40, 60)` / `2px` /
  `20px`; Counter `4px 12px` / `rgb(120, 40, 160)`; Button `4px 12px`, background `rgb(90, 50, 160)`, weight `600`.
  The same values the React page gives. Button's `color` is left out: the React page sets it red through `style`
  (the Svelte Button has no root `class` / `style` props: 6.4 is React only).
- Svelte 5's production `hydration_mismatch` is a `console.warn`, so a console check catches it. Its other hydration
  warnings (`hydration_attribute_changed`, `hydration_html_changed`) print only in dev, hence a `vite dev` run too.
  `vite dev` of the same app: styled, click works, only Vite's `debug` lines.

## Plan

1. **Template** `packages/e2e/fixtures/apps/consumer-sveltekit/`, no multifront package:
   - `package.json`: `private`, `type: module`, devDependencies at the pins above (the way `sv create` writes them).
   - `svelte.config.js`: `{kit: {adapter: adapter()}}` with `@sveltejs/adapter-node`.
   - `vite.config.ts`: `defineConfig({plugins: [sveltekit()]})`.
   - `tsconfig.json`: `sv create`'s shape, extends `./.svelte-kit/tsconfig.json`, with `allowJs`, `checkJs`,
     `esModuleInterop`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `skipLibCheck`, `sourceMap`,
     `strict`, `moduleResolution: bundler`.
   - `src/app.html`: `%sveltekit.head%`, `%sveltekit.body%`, `<link rel="icon" href="%sveltekit.assets%/favicon.svg">`,
     with `static/favicon.svg` (6.10's file), so no favicon 404 reaches the console.
   - `src/routes/+page.svelte`: `Button`, `Card`, `Counter` from `@mf-fixture/ui-svelte`;
     `<Card title="Hello"><Counter /></Card>`, `<Button label="Go" onclick={() => clicks++} />`,
     `<output id="clicks">`. `onMount` sets `document.body.dataset.hydrated`.
2. **Consumer helpers**, `packages/e2e/consumer/lib/app.ts`:
   - `KEY_STYLES` (the table above: selector → `{property: value}`) and `keyStyles(page)` (reads them with
     `browser/lib/parity.ts`'s `styles`): the one table every framework's page must equal.
   - `expectHydrates(url, counterSelector, more?)`: 6.12's hydrate check moved out of `next.spec.ts`, used by both
     specs (Svelte's `more` clicks Button and checks `KEY_STYLES`).
3. **Spec** `packages/e2e/consumer/sveltekit.spec.ts`, `serveConsumerApp({target: 'svelte', template:
   'consumer-sveltekit', build: vite build, serve: env PORT=<port> node build})` (adapter-node reads only `PORT`;
   the consumer job is Linux only):
   - installs the `@mf-fixture/ui-svelte` tarball and no `@multifront` package.
   - `svelte-kit sync` + `svelte-check --fail-on-warnings`: exit 0, `0 ERRORS 0 WARNINGS`.
   - a `<Card titel="x" />` page written to `src/routes/wrong/+page.svelte`: `svelte-check` exits 1 with one `ERROR`
     naming that file and `titel`; the page is removed in `finally`. A failed `svelte-kit sync` throws with its output.
   - `vite build` output has `built in` and `Using @sveltejs/adapter-node`.
   - server HTML: Card's `data-v-*` (`scopeAttribute` over `src/Card.ucf`) on `<article`, Counter's on `<button`, no
     `<style`; every `rel="stylesheet"` link fetched, that CSS holds `--card-padding` and `.counter[data-v-`. JavaScript
     off: `expectStyledCard`, Counter shows `Count 0`, `body` has no `data-hydrated`.
   - hydrates under the node server: waits for `body[data-hydrated]`, Counter goes to `Count 1`, a Button click sets
     `#clicks` to `1`, `keyStyles(page)` equals `KEY_STYLES`, no console problem.
   - the same hydrate check under `vite dev` (same app, beside the node server): dev Svelte prints every hydration
     warning.
4. **6.10 side**: `vite-react.spec.ts`'s render test also checks `keyStyles(page)` against `KEY_STYLES` (its own
   Button `font-weight` assert goes: the table pins it).
5. **CI**: the three floor jobs get `--exclude 'consumer/sveltekit.spec.ts'`. The `consumer` job already runs the
   folder, and its store cache key already hashes `consumer-*/package.json`.
6. **Milestone doc**: `- Status: done` on 6.13, the `vite dev` line in its Test, `KEY_STYLES` and `keyStyles` in
   "Hands to later milestones" (the exit test's visual parity).

## Tests

- Consumer area: this host (registry + Chromium checked above) and CI's `consumer` job. No new infra: same jobs, same
  Chromium, same store cache. The PR shows the CI log lines of `sveltekit.spec.ts` running.

## Docs

- `docs/milestones/m6-library-build.md` only (item 6). `docs/plan.md` already names the SvelteKit exit check; spec and
  architecture do not change.

## Fuzzing

- None: no cheap oracle.

## Decisions

- Visual parity through one shared `KEY_STYLES` table asserted by both `vite-react.spec.ts` and `sveltekit.spec.ts`;
  the live four-app comparison stays in the exit test. (Orchestrator.)
- Add a `vite dev` run of the same app for dev-only hydration warnings, plus one line in the step text. (Orchestrator.)
- No fuzz test. (Orchestrator.)
- Review: the port goes through `env PORT=<port> node build`, not a new `serveApp` option; `expectHydrates` shared
  with `next.spec.ts`; the wrong-prop page written from a constant in the spec, not a template file; `keyStyles`
  reuses `parity.ts`'s `styles`.

## Out of scope

- A CSP in the SvelteKit app: 6.13 does not ask for one, and Kit's inline bootstrap needs `kit.csp` hashes.
- The four-app live parity run: the exit test.

## Done when

- `pnpm devx test packages/e2e/consumer/sveltekit.spec.ts packages/e2e/consumer/vite-react.spec.ts` passes on this
  host, `pnpm devx check` passes, CI's `consumer` job is green with the new spec in its log.
- 6.13 has `- Status: done`; this spec is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
