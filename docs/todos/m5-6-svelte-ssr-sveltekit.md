---
type: feature
spec: full-plan
status: ready
created: 2026-10-12
milestone: 5
step: 5.6
---

# Milestone 5.6: SSR and a SvelteKit app built from `.ucf` sources

## Problem

Nothing proves the Svelte target of a `.ucf` file renders on the server and hydrates in a real SvelteKit app, with the
same `data-v-*` on server and client (spec 2: hydration needs a deterministic scope id). `apps/svelte-vite` has a
`src/entry-server.ts` but no test serves it, and there is no SvelteKit app.

Checked on this host with a throwaway probe (SvelteKit 2.70.3, adapter-node 5.5.7, Vite 8.2.2, plugin-svelte 7.3.0,
svelte 5.57.0; again on the floor svelte 5.55.6 + plugin-svelte 7.0.0), `@multifront/vite` from `src/`
(`--conditions=source`), `multifront()` before `sveltekit()`, a route `+page.svelte` importing `Panel.ucf` and
`Counter.ucf` from outside the app root:

- **Dev** (`vite`): `GET /` is server HTML with `<section data-v-8bf6d244="" class="panel" …>`, PanelItem's
  `<p data-v-09d450ac="" …>`, `<div data-v-c4f952ac="" class="counter">`, the button with `2`. SvelteKit's dev server
  **inlines** the CSS as `<style data-sveltekit>` (no `<link>`), holding `.panel[data-v-8bf6d244]`,
  `.counter[data-v-c4f952ac]` and `.button_c4f952ac_1`.
- **Build** (`vite build`, `node build/index.js`): the HTML has
  `<link href="./_app/immutable/assets/2.<hash>.css" rel="stylesheet">`, that file holds the production-scoped rules
  (`.panel[data-v-cdceba16]{…}`); the page's client chunk holds the same `data-v-cdceba16`.
- **Hydration in Chromium**, dev and build: no console warning or error; the server-rendered `section.panel` is the
  same DOM node after hydration (hydrated, not re-mounted), its `data-v-*` unchanged; a click counts 2 → 3. An element
  the client renders after hydration carries the same id as the server stamps.
- **A new dev server process** on the same copy (`.svelte-kit/` and the dep cache kept, our in-memory caches empty)
  renders and hydrates the same.
- The same on the floor.

So no `@multifront/vite` or core change is needed: this step adds the app, the test and two process helpers.

## Decisions

- Orchestrator: dev checks the inline `<style data-sveltekit>`, a build checks the `<link>` CSS file (what SvelteKit
  2.70.3 really does); the 5.6 Test line says so.
- Orchestrator: "restart the dev server" is a new dev server process, the real cache miss (as M4's Vue cache-miss
  tests); the 5.6 Test line says so.
- Orchestrator: the `/items` route is in scope. Hydration keeps the server's attributes, so only a client-rendered
  element can show a client id that differs.
- Orchestrator: no fuzz test (5.7 is the Svelte fuzz).

## Plan

1. Root devDependencies, exact-pinned (`pnpm add -D -w`): `@sveltejs/kit` 2.70.3 (2026-08-18) and
   `@sveltejs/adapter-node` 5.5.7 (2026-06-24), both past the 30 day release age. Kit's peers are met (vite ^8,
   svelte ^5, plugin-svelte ^7, typescript ^6; `@opentelemetry/api` optional). Test tools: root, not `packages/e2e`.
2. Fixture app `packages/e2e/fixtures/apps/sveltekit-src/`:
   - `package.json`: `{"name": "sveltekit-src", "private": true, "type": "module"}`. adapter-node reads it from the cwd
     at build time; Vite's dep cache stays inside the copy. Outside the `packages/*` workspace glob.
   - `svelte.config.js`: `kit: {adapter: adapter()}` from `@sveltejs/adapter-node`.
   - `vite.config.ts`: `plugins: [multifront(), sveltekit()]`.
   - `src/app.html`: the standard shell (`%sveltekit.head%`, `<div id="svelte">%sveltekit.body%</div>`,
     `<link rel="icon" href="data:,">` so no favicon 404 reaches the console).
   - `src/routes/+page.svelte`: `../../../../components/Panel.ucf` bare (the `.svelte` importer rule), `Counter.ucf`
     with `with { framework: 'svelte' }`; renders `<Panel heading="Kit panel" />`, `<Counter start={2} />` and
     `<a href="/items">Items</a>`; `onMount` sets `document.body.dataset.hydrated = 'true'` (the test's signal that
     hydration ran).
   - `src/routes/items/+page.svelte`: `PanelItem.ucf`, rendered as `<PanelItem label="client item" />`. The test
     reaches it by client-side navigation, so the client compiles and stamps it.
3. `packages/e2e/build/lib/freshProcess.ts`, beside `startSsrServer()`:
   - `startViteDev(root)`: `startViteCli(root, ['--port', '0'], {NODE_ENV: 'development'})`, `url` a promise of the
     `Local:\s+(\S+)` line;
   - `startNodeServer(root, entry)`: `startNode(root, [entry], {NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1'})`,
     `url` a promise of adapter-node's `Listening on (\S+)` line.
   - Both returned at once, as `startSsrServer()`, so a hang leaks no child.

## Tests

`packages/e2e/browser/svelte-ssr.spec.ts` (Playwright, `launchChromium()`), under `pnpm devx test`, on this host and in
CI's `check`, `react-floor`, `vue-floor` and `svelte-floor` jobs. No new infra: child processes (4.7) and Chromium (3.9)
are there. Each describe uses its own `copyApp('sveltekit-src')`, removed after; children stop in `onTestFinished` /
`afterAll`. Expected ids: `scopeAttribute(root, file, production)` for `Panel.ucf`, `PanelItem.ucf`, `Counter.ucf`.

`checkPage(url, production)`, shared by every load:

- A `page.addInitScript` MutationObserver keeps the first `section.panel` node the parser inserts.
- The navigation response body (server HTML) holds `<section data-v-<panel>="" class="panel"`,
  `<p data-v-<item>="" class="item"`, `<div data-v-<counter>="" class="counter">`, the button with `2`; and the CSS:
  in dev the inline `<style data-sveltekit>`, after a build the `<link rel="stylesheet">` file (fetched). Both contain
  `.panel[data-v-<panel>]`, `.item[data-v-<item>]`, `.counter[data-v-<counter>]` and the button's `$style` class from
  the HTML (`hasClass()`).
- Wait for `body[data-hydrated]`. The kept node is still `document.querySelector('section.panel')` (hydrated, not
  re-mounted) and still carries `data-v-<panel>`.
- Click the button: `expect.poll` sees `3`.
- Click the `/items` link: `client item` shows, its `<p>` carries `data-v-<item>`, still one `load` event (a client
  render, same id).
- No `warning`, `error` or `pageerror` in the console (Svelte's dev `hydration_mismatch` is a warning).

Cases:

- **Dev, then a restart (cache miss)**: `startViteDev(copy)`, `checkPage(url, false)`, no `/error/i` in the server
  output; stop the process, start a new one on the same copy, `checkPage(newUrl, false)` again.
- **Build**: `startViteCli(copy, ['build'], {NODE_ENV: 'production'}).finished()`, then
  `startNodeServer(copy, 'build/index.js')`, `checkPage(url, true)`.

Measured before committing, on a throwaway copy: a `+page.svelte` that renders other markup on the server than on the
client fails the test.

## Docs

- `docs/milestones/m5-svelte-target.md` 5.6: `- Status: done`; the Test line says dev checks the inline
  `<style data-sveltekit>`, a build the CSS link, and "restart" is a new dev server process; names the two routes and
  the helpers.
- `spec.md`, `plan.md`, `architecture.md`: none (no plugin change, no new decision, no structure change).
  `publicdocs/`: none (the milestone's docs writer covers SvelteKit setup).

## Fuzzing

None. 5.7's scope fuzz covers SSR render of generated files.

## Out of scope

- Any `@multifront/vite` or core change (none needed, per the probe).
- HMR through SvelteKit, prerendering, streaming, `+page.server.ts` load functions.
- The SvelteKit consumer of packed packages (milestone 6). Root forwarding (5.8).

## Done when

- `svelte-ssr.spec.ts` passes on this host and in CI; CI log lines show it executing, `svelte-floor` included.
- `pnpm devx check` green; milestone doc updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
