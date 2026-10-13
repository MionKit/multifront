---
type: feature
spec: full-plan
status: ready
created: 2026-10-13
milestone: 6
step: 6.10
---

# Milestone 6.10: consumer, a fresh Vite React app

## Problem

6.1 to 6.9 build, type and pack `@mf-fixture/ui-react`, but no test installs the tarball into a real app. This is the
first fresh install from the npm registry. The consumer area holds only `consumer/lib/pack.ts` (`packLibrary`,
`tarFiles`, `publint`, `attw`) and `pack.spec.ts`. The README's "Test infrastructure" Consumer row and the 6.7 spec put
the consumer CI job here: "a job that builds and packs once and hands the tarballs to the consumer jobs, a shared pnpm
store".

Checked on this host with throwaway copies:

- `mf-build --framework react` on the fixture, then `pnpm pack`: about 2 s.
- A fresh app in the OS temp dir with its own `pnpm-workspace.yaml` (the repo's policy: `savePrefix: ''`,
  `minimumReleaseAge: 43200`, `ignoreScripts`, `allowBuilds: {}`, `verifyStoreIntegrity`,
  `allowNonRegistryProtocols: false`, strict peers, `autoInstallPeers: false`): `pnpm install` 5.5 s, `pnpm add <tgz>`
  1.3 s. A `file:` tarball passes `allowNonRegistryProtocols: false`; `CI=true` with no lockfile installs.
- `tsc --noEmit` passes with `// @ts-expect-error` on `<Card titel="x" />`; without it, TS2322: the shipped `.d.ts`
  is used.
- `vite build --sourcemap --manifest` with `build.rolldownOptions.input` `{main: 'index.html', 'only-card':
  'src/only-card.tsx'}`: only-card's chunks' map `sources` list `@mf-fixture/ui-react/Card.js`, `Icon.js`, `cx.js`,
  never `Counter.js` or `hooks/useToggle.js`; `.counter[data-v-…]` is only in `main`'s CSS.
- `vite preview` + Chromium under CSP `default-src 'self'; style-src 'self'`: Card padding `16px`, color
  `rgb(30, 60, 90)`, title `rgb(150, 40, 60)`, Counter `Count 0` → `Count 1`, Button classes `button_<hash> extra`,
  color `rgb(255, 0, 0)`, weight `600`, ref tag `BUTTON`. An injected inline `<style>` is refused and logged.
- `<link rel="icon" href="data:,">` is a CSP `img-src` violation and a missing favicon a 404 console error: the
  template ships `public/favicon.svg`.
- `vitest --exclude 'consumer/**'` drops `packages/e2e/consumer/` only (globs are relative to each project root).

## Plan

1. **Template** `packages/e2e/fixtures/apps/consumer-vite-react/`, no multifront package:
   - `package.json`: `react`, `react-dom` 19.3.0; dev `vite` 8.2.2, `@vitejs/plugin-react` 6.1.1, `typescript`
     6.0.3, `@types/react`, `@types/react-dom` 19.3.0 (the root's pins).
   - `index.html` with the CSP meta and `/favicon.svg`; `public/favicon.svg`; `tsconfig.json` (bundler, react-jsx,
     strict, `skipLibCheck`, `types: ['vite/client']`); `vite.config.ts` with the two inputs.
   - `src/main.tsx`, `src/App.tsx` (`Card` holding `Counter`, `Button` with `className`, `style`, `ref`, the ref's tag
     written into `#button-ref`), `src/only-card.tsx` (only `Card`, from the package index), `src/checks.tsx` (the
     wrong prop under `@ts-expect-error`, never bundled).
2. **`packages/e2e/consumer/lib/app.ts`**: `createConsumerApp(template, tarballs: string[]): Promise<ConsumerApp>`
   (`{dir, remove()}`), `runInApp(app, command: string[])` (`{code, output}`, never throws on exit code),
   `serveApp(app, command: string[], port)` (`{url, output(), close()}`, own process group, polls until it answers),
   `freePort()`, `openPage(url)` (`{page, messages, close()}`, CSP violations turned into console errors).
   Child processes get the shell env minus what Vitest and pnpm add (`NODE_ENV`, `NODE_PATH`, `VITEST*`, `TEST`,
   `npm_package_*`, `npm_lifecycle_*`) and minus `PATH` entries inside the repo. `MULTIFRONT_KEEP_CONSUMER_APPS`
   keeps the app and prints its path.
3. **Build once**: `packFixtureLibrary(dir)` and `fixtureTarballs(dir = MULTIFRONT_CONSUMER_TARBALLS)` in
   `consumer/lib/pack.ts`, entry `consumer/lib/packFixture.ts`, devx command `consumer-pack <dir>`.
4. **CI**: `consumer-pack` job uploads the tarballs; `consumer` job downloads them, caches the pnpm store, installs
   Chromium, runs `packages/e2e/consumer/`. `check` and the floor jobs `--exclude 'consumer/**'`.
5. **Env**: `MULTIFRONT_KEEP_CONSUMER_APPS` (dev, `.env.sample`), `MULTIFRONT_CONSUMER_TARBALLS` (internal).

## Decisions

- CI split as planned: `consumer-pack` + `consumer`, the area out of `check` and the floor jobs. (Orchestrator,
  rule 1: README "Test infrastructure", Consumer row.)
- No fuzz test. (Orchestrator.)

## Tests

`packages/e2e/consumer/vite-react.spec.ts`: setup builds (or takes CI's) tarballs, creates the app, runs
`vite build --sourcemap --manifest` and `vite preview`. Checks: the app holds `@mf-fixture/ui-react` and no
`@multifront` package; `tsc --noEmit` exits 0; Card, Counter, Button render as above with no console problem; a CSP
canary; only-card's graph has `Card.js` and `--card-padding` but no `Counter.js`, `useToggle.js` or `.counter`, while
`main`'s has them. `pack.spec.ts`: `devx consumer-pack` writes `tarballs.json` and `fixtureTarballs(dir)` reads it.

Where: this host (registry reachable, Chromium via `.env`), and CI's `consumer` job.

## Docs

- Milestone doc 6.10 (`Status: done`, shipped shapes) and its "Hands to later milestones" consumer line.
- `docs/milestones/README.md` Consumer row; `SETUP.md`; `scripts/lib/registry.mjs`, `scripts/lib/env.mjs`,
  `.env.sample`.

## Out of scope

- 6.11 to 6.13 and the exit test; a local registry; a per-app CI matrix; Windows for the consumer area.

## Done when

- Both tests pass here and in CI's `consumer` job, and its log shows them running. `pnpm devx check` passes.
- Docs updated; todo moved to `docs/done/`; comment pass committed on its own.
