---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 4
step: 4.8
---

# Milestone 4.8: SSR for the Vue target

## Problem

`apps/vue` renders on the client only (`index.html` → `src/main.ts` → `createApp(App)`). Nothing proves the Vue
target of a `.ucf` file renders on the server and hydrates on the client, with the same scope id on both sides (spec 2:
hydration needs it).

Checked on this host (Vite 8.2.2, plugin-vue 6.0.8, vue 3.5.42) with throwaway probe scripts:

- Dev: `ssrLoadModule('/src/App.vue')` + `renderToString(createSSRApp(App))` gives
  `<div class="counter" data-v-c4f952ac>…<button class="button_c4f952ac_1" …>2</button>`; the client transform of
  `/@fs/…/Counter.ucf` has `__scopeId` `data-v-c4f952ac`.
- Production: `build({build: {ssr: 'src/App.vue'}})` + a client `build()`, rendered with plain Node: `data-v-a5afa5a3`
  in the HTML, `.counter[data-v-a5afa5a3]` in the client CSS.

So no `@multifront/vite` change is expected. Hydration in a real browser was not run yet; a fix it needs lands here
(own commit, own test).

## Decisions

- Orchestrator, Q1: no `@vue/server-renderer` root devDependency. `vue/server-renderer` ships inside `vue` (a root
  devDependency), and `vue-floor` then renders with the `vue` floor's own copy. The milestone's "New dependencies"
  line is corrected.
- Orchestrator, Q2: the SSR template sits inline in `server.ts`; `index.html` and `src/main.ts` stay the client-only
  app 4.4 to 4.7 build and 4.9 serves (a hydrating entry there would warn on its empty container).
- Orchestrator: no fuzz test.

## Plan

1. `packages/e2e/fixtures/apps/vue/src/entry-server.ts`: `export function render(): Promise<string>` =
   `renderToString(createSSRApp(App))`, `renderToString` from `vue/server-renderer`.
2. `packages/e2e/fixtures/apps/vue/src/entry-client.ts`: `createSSRApp(App).mount('#app')` (hydrates).
3. `packages/e2e/fixtures/apps/vue/server.ts`, dev SSR server, run as `node --conditions=source server.ts`:
   - a `node:http` server, and Vite's `createServer()` with `root: import.meta.dirname`, `configLoader: 'native'`
     (the app's `vite.config.ts` loads `@multifront/vite` from `src/`), `appType: 'custom'`,
     `server: {middlewareMode: true, hmr: {server: httpServer}}` (the HMR websocket shares our port, so parallel test
     processes never fight over Vite's default 24678);
   - `GET /` after `vite.middlewares`: `vite.transformIndexHtml()` of an inline template
     (`<div id="app"><!--app-html--></div>`, script `/src/entry-client.ts`, `<link rel="icon" href="data:,">`), then
     `vite.ssrLoadModule('/src/entry-server.ts')`, `render()`, HTML into the placeholder. Error →
     `vite.ssrFixStacktrace`, 500 with the stack. Other URLs Vite does not serve → 404;
   - listens on port 0, writes `ssr server: http://localhost:<port>/` to stdout (oxlint `no-console`, no env var).
4. `packages/e2e/build/lib/freshProcess.ts`:
   - `startViteCli()` becomes a thin call of new `startNode(root, args, env)` (same spawn, `node --conditions=source
     …args` in `root`, `NO_COLOR=1`);
   - the handle gains `finished()`: resolves with the output on exit code 0, rejects with it otherwise;
   - new `startSsrServer(root)`: `startNode(root, ['server.ts'], {NODE_ENV: 'development'})`, waits for the
     `ssr server: (\S+)` line, returns the handle plus `url`.
5. Any fix found: in `packages/vite/src/`, own commit, own test.

## Tests

Both run under `pnpm devx test`, on this host and in CI's `check`, `react-floor` and `vue-floor` jobs. No new infra:
child processes (4.7) and Playwright Chromium (3.9) are there. Each spec uses its own `copyApp('vue')` with a
`package.json` written into it (the dep cache stays in the copy), removed after; children stop in `onTestFinished` /
`afterAll`. Expected ids come from core's `scopeId(rootRelativePath(root, file), source, production)`.

`packages/e2e/build/vue-ssr.spec.ts`:

- **Dev SSR in a fresh process**: `startSsrServer(copy)`; the first request is `GET /` (`ssrLoadModule()` on a cold
  plugin-vue cache), then `GET /@fs<copy>/…/Counter.ucf` (the client module). 200; the HTML has
  `<div class="counter" data-v-<id>>` and the button with `2` (App passes `:start="2"`); `<id>` equals
  `exportedScopeId()` of the client module and the dev `scopeId()`; no `/error/i` in the server output.
- **Production, two processes**: `vite build --outDir dist/client` and
  `vite build --ssr src/entry-server.ts --outDir dist/server`, each its own `startViteCli(…, {NODE_ENV:
  'production'})` awaited with `finished()`; then plain `node --input-type=module -e` imports
  `dist/server/entry-server.js` and prints `await render()`. The `.counter` `data-v-*` equals `.counter[data-v-<id>]`
  in the client CSS and the production `scopeId()`; the rendered `$style.button` class is the client CSS's too.

`packages/e2e/browser/vue-hydration.spec.ts` (Playwright, `launchChromium()`):

- `startSsrServer(copy)`, `collectConsole(page)`, `page.goto(url)`; the navigation response body already holds the
  Counter markup with the dev `data-v-*` and `2` (server-rendered, not a client render);
- wait until `#app` has `__vue_app__` (Vue sets it on mount in every build); click: `expect.poll` sees `3`;
- no `warning`, `error` or `pageerror` in the console (Vue's dev hydration mismatch is a `[Vue warn]` warning plus a
  `console.error` "Hydration completed but contains mismatches.").

## Docs

- `docs/milestones/m4-vue-target.md`: 4.8 `- Status: done`; its text names `startSsrServer()` / `finished()` and the
  inline template; the "New dependencies" line drops `@vue/server-renderer`.
- `spec.md`, `plan.md`, `architecture.md`: none (plan milestone 4 already lists SSR; no structure change).
  `publicdocs/`: none.

## Out of scope

- A production mode in `server.ts` and browser hydration of the production SSR build (exit test 2).
- HMR through the SSR server (4.9). Streaming render, SSR CSS preload links.

## Done when

- Both specs pass on this host and in CI; CI log lines show them executing.
- Any fix found has its own commit and a test that fails without it.
- `pnpm devx check` green; milestone doc updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
