---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.9
---

# Milestone 3.9: Browser harness and first render

## Problem

No test opens a real browser: `packages/e2e/browser/` is empty, CI installs no Chromium, and React tests run only
on the pinned top of the peer ranges (`react` 19.3.0, plugin-react 6.1.1). The milestone promises every React test
also runs on the oldest supported React. Steps 3.10 to 3.16 and milestones 4 to 6 build on these helpers and the
floor job.

## Plan

### 1. `packages/e2e/browser/lib/serve.ts`

- `startDev(appDir): Promise<{url: string; server: ViteDevServer; close(): Promise<void>}>`:
  `createServer({root: appDir, configLoader: APP_CONFIG_LOADER, cacheDir: <mkdtemp under TMP_DIR>, logLevel:
  'silent', server: {port: 0}})` inside `withNodeEnv('development')`, then `listen()`; `url` =
  `server.resolvedUrls.local[0]`. `close` waits for `environments.client.waitForRequestsIdle()` before
  `server.close()` (Vite's close never settles during its first crawl), then removes the cache dir.
- `buildAndPreview(appDir): Promise<{url: string; outDir: string; close(): Promise<void>}>`: `outDir` = mkdtemp under
  `TMP_DIR` (never inside the fixture); `buildApp(appDir, {build: {write: true, outDir, emptyOutDir: true}})` (already
  production NODE_ENV + native loader), then `preview({root: appDir, configLoader: APP_CONFIG_LOADER, logLevel:
  'silent', build: {outDir}, preview: {port: 0}})`. `close` closes the preview server and removes `outDir`.
- Reuses `APP_CONFIG_LOADER`, `withNodeEnv`, `buildApp` (`build/lib/build.ts`) and `TMP_DIR` / `copyApp`
  (`fixtures/index.ts`). Tests that edit files (3.15 on) pass a `copyApp(name)` copy as `appDir`.

### 2. `packages/e2e/browser/lib/chromium.ts`

- `launchChromium(): Promise<Browser>`: `chromium.launch({executablePath: process.env.MULTIFRONT_CHROMIUM_PATH ||
  undefined})`; a failed launch rethrows with one line naming the fix (`pnpm exec playwright install chromium`, or
  set `MULTIFRONT_CHROMIUM_PATH`).
- `collectConsole(page): ConsoleEntry[]`: a live list of every `console` message (`{type, text}`) and every
  `pageerror` (`type: 'pageerror'`). `ConsoleEntry` stays in this file.

### 3. Fixture fix

- `fixtures/apps/react-basic/index.html` gains `<link rel="icon" href="data:," />`: without it the browser's favicon
  request is a 404 console error, in dev and preview.

### 4. `pnpm devx peer-floor <framework>`

- `scripts/lib/peer-floor.mjs`:
  - `FLOOR_PEERS = {react: {peers: ['react', 'react-dom', '@vitejs/plugin-react'], types: {'@types/react': 'react',
    '@types/react-dom': 'react-dom'}}}`. M4 and M6 add a row.
  - `floorOverrides(framework)`: reads `packages/vite/package.json` `peerDependencies`, the lowest version of each
    range (`^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` or bare `X.Y.Z`; anything else is an error naming the package and range);
    each types package gets the floor of the package it follows. React: `{react: '19.0.0', 'react-dom': '19.0.0',
    '@vitejs/plugin-react': '6.0.0', '@types/react': '19.0.0', '@types/react-dom': '19.0.0'}`.
  - `withOverrides(workspaceYaml, overrides)`: appends an `overrides:` block to the `pnpm-workspace.yaml` text;
    throws when the file already has an `overrides:` key.
- `scripts/devx.mjs` handler: refuses unless `CI` is set (it rewrites the lockfile); refuses an unknown or missing
  framework, naming the known ones; writes the overrides into `pnpm-workspace.yaml`; runs `pnpm install
  --no-frozen-lockfile`; checks every overridden package found in the root's or a workspace package's `node_modules`
  is at its floor version (fails otherwise); prints `peer-floor: <name> <version>` per package.
- Row in `scripts/lib/registry.mjs`.
- `scripts/lib/env.mjs` + `.env.sample`: `CI` description adds that `peer-floor` runs only with it set;
  `MULTIFRONT_CHROMIUM_PATH` now covers the browser tests too.

### 5. CI (`.github/workflows/ci.yml`)

- `check` job, before `Test`: read the Playwright version into a step output; `actions/cache@v5` on
  `~/.cache/ms-playwright` keyed `playwright-${{ runner.os }}-<version>`; `pnpm exec playwright install --with-deps
  chromium`.
- New `react-floor` job (ubuntu): checkout, pnpm, node 26, `pnpm install --frozen-lockfile`, `pnpm devx peer-floor
  react`, the same Chromium cache + install, the same `.vscode-test` cache, `pnpm devx test --reporter verbose`.

### 6. Docs

- `SETUP.md`: `peer-floor` in the command list (CI only); the browser tests need Playwright's Chromium (`pnpm exec
  playwright install chromium`) or `MULTIFRONT_CHROMIUM_PATH`.
- Milestone doc step 3.9: CI installs Chromium "before the Test step" (CI splits `check` into steps);
  `- Status: done`.

## Tests

- `packages/e2e/browser/react-render.spec.ts` (area browser; this host, CI `check` and `react-floor`). One Chromium per
  file; for `dev` (`startDev`) and `preview` (`buildAndPreview`) on `react-basic` in place: a fresh page with
  `collectConsole`, `goto(url)`, wait for `all-blocks-react-marker`; AllBlocks renders; the `$style.card` div (the
  marker's parent) has computed `padding` `16px`; the `classes.title` `<p>` ("All blocks") `color`
  `rgb(20, 90, 160)`; `.all-blocks-global` `font-style` `italic`; no `error` and no `pageerror` console entry.
- `packages/e2e/devx/peer-floor.spec.ts` (area devx, this host and CI), on the real repo files:
  `floorOverrides('react')` equals the map above; `withOverrides` on the real `pnpm-workspace.yaml` text ends with
  that `overrides:` block and a second run throws; `devx peer-floor react` without `CI` exits 1 with its message and
  leaves `pnpm-workspace.yaml` byte for byte; `devx peer-floor angular` with `CI` exits 1 naming `react`, nothing
  changed.
- The full reinstall is proven by the `react-floor` job (the command checks the installed versions), and once by hand
  before the PR on a throwaway `git worktree` (`CI=1 pnpm devx peer-floor react`, then `pnpm devx test`): react,
  react-dom, @types 19.0.0 and plugin-react 6.0.0 installed, all 37 test files green, the browser test included.

## Done when

- `pnpm devx check` green on this host; both CI jobs green with the new browser tests executed (not skipped), CI log
  lines quoted in the PR.
- `- Status: done` on step 3.9; this todo in `docs/done/`.

## Out of scope

- Scope stamping, forwarding, the demo, HMR (3.10 on). `vue-floor`, `svelte-floor` (M4, M6). Other browsers.

## Decisions

- `peer-floor` refuses to run unless `CI` is set (orchestrator: settled by the step text, "runs in CI only, on a
  throwaway checkout").
