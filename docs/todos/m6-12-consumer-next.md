---
type: feature
spec: full-plan
status: ready
created: 2026-10-13
milestone: 6
step: 6.12
---

# Milestone 6.12: consumer, a fresh Next.js App Router app

## Problem

6.10 and 6.11 install the packed React and Vue packages into fresh Vite apps. Nothing checks that the React package
works in Next.js App Router yet. That means server rendering, React Server Components, the `"use client"` lines from
6.3, and CSS imported from `node_modules`. The consumer area already has the tools this step needs
(`serveConsumerApp`, `createConsumerApp`, `runInApp`, `serveApp`, `freePort`, `openPage`, `expectStyledCard`,
`packLibrary`), plus CI's `consumer-pack` and `consumer` jobs. What's missing: a Next template and its spec.

Checked on this host with a throwaway app (the repo's install policy, the real `mf-fixture-ui-react-1.2.3.tgz`):

- `next` 16.3.5 is the newest release older than 30 days (2026-09-11; 16.4.0 is from 2026-10-06), so the
  `minimumReleaseAge` policy accepts it. Its peers are `react` / `react-dom` `^19.0.0`, so 19.3.0 (the root's pin) fits.
- Without `@types/node`, `next build` installs it with pnpm while the build runs. That first build then failed while
  prerendering `/_global-error` ("Invariant: Expected workStore"). So the template pins `@types/node` 26.6.4 (the
  root's pin). `next build` also rewrites `tsconfig.json` unless it already has `.next/dev/types/**/*.ts` in `include`
  and `exclude: ["node_modules"]`, so the template ships that final shape.
- With those changes, `next build` (Turbopack) passes. It compiles, runs TypeScript and prerenders `/` as static, with
  no `⚠` line.
- Without the directive (first line of the installed `Counter.js` removed), `next build` fails while prerendering `/`
  with `TypeError: (0 , h.useState) is not a function or its return value is not iterable`. That is the real message
  for a library file. "useState only works in Client Components" is the message for app code.
- `next start` + Chromium with JavaScript off: Card padding `16px`, styled from
  `<link rel="stylesheet" href="/_next/static/chunks/….css">` in the server HTML. Counter shows `Count 0` inside
  `section.panel`. Button is server rendered as `class="button_<hash> extra" style="font-weight:600;color:red"`.
  Tooltip and `forms/Field` (subpath) render. Card's root has `data-v-d20878a2`.
- With JavaScript on: Counter goes to `Count 1` after a click, and the console is empty. Proof the check can fail: a
  client component rendering `typeof window` showed `pageerror: Minified React error #418`.
- `next dev` in the same folder, at the same time as `next start` (Next 16 writes dev output to `.next/dev`): styled,
  click works, only `info` (React DevTools) and `log` (`[HMR] connected`) messages.

## Plan

1. **Template** `packages/e2e/fixtures/apps/consumer-next/`, no multifront package:
   - `package.json`: `next` 16.3.5, `react` 19.3.0, `react-dom` 19.3.0; dev `typescript` 6.0.3, `@types/react`
     19.3.0, `@types/node` 26.6.4 (Next needs it, see Problem).
   - `tsconfig.json`: 6.10's compiler options plus what Next requires (`isolatedModules`, `esModuleInterop`,
     `resolveJsonModule`, `allowJs`, `incremental`, `plugins: [{name: "next"}]`). `include`: `next-env.d.ts`,
     `app`, `.next/types/**/*.ts`, `.next/dev/types/**/*.ts`. `exclude: ["node_modules"]`. Next writes
     `next-env.d.ts` itself, so the template does not ship it.
   - `app/layout.tsx`: server component, `<html><body>`, renders `<Hydrated />`.
   - `app/hydrated.tsx`: `'use client'`, an effect sets `document.body.dataset.hydrated`. The spec waits for it
     before clicking, the same way `svelte-ssr.spec.ts` waits for `body[data-hydrated]`.
   - `app/page.tsx`: server component, no directive. Renders `Card` holding `Panel` (which renders `Counter`),
     `Button` with `label`, `className="extra"`, `style={{color: 'red'}}` (props a server component can pass), and
     `Tooltip` with text children, all from `@mf-fixture/ui-react`. Also `Field` from `@mf-fixture/ui-react/forms/Field`.
2. **Consumer helpers** in `packages/e2e/consumer/lib/app.ts`:
   - `openPage(url, {javaScript = true} = {})`: opens the page in `browser.newContext({javaScriptEnabled})`.
   - `ServedApp` gains `tarball` (the installed one), so the spec can build a changed copy of it.
   - `consumerEnv()` sets `NEXT_TELEMETRY_DISABLED=1`, so tests never send Next's telemetry. It goes in
     `scripts/lib/env.mjs` `REGISTRY` as `internal`.
3. **CI**: the three floor jobs (`.github/workflows/ci.yml:76`, `:97`, `:118`) also get
   `--exclude 'consumer/next.spec.ts'`. The `consumer` job already runs the folder, and its store cache key already
   hashes `consumer-*/package.json`.

## Decisions

- Keep the stripped-directive build: a second install and `next build` that must fail. (Orchestrator.)
- `NEXT_TELEMETRY_DISABLED=1` in `consumerEnv()`, with its `REGISTRY` row. (Orchestrator.)
- No CSP in the Next app: Next's inline bootstrap scripts need a nonce setup. (Orchestrator.)
- No fuzz test. (Orchestrator.)

## Tests

`packages/e2e/consumer/next.spec.ts`. Setup goes through `serveConsumerApp({target: 'react', template:
'consumer-next', build: ['pnpm', 'exec', 'next', 'build'], serve: next start --port})`. Checks:

- The app holds `@mf-fixture/ui-react` and no `@multifront` package.
- `next build` passes: the output has `Compiled successfully` and no `⚠` line. Next's own TypeScript run checks
  `app/` against the shipped `.d.ts`.
- **The directive is needed**: the installed tarball is unpacked to a temp dir, the first line `"use client";` of
  `Counter.js` is dropped (after checking it is there), the folder is repacked with `packLibrary` and installed into a
  second `createConsumerApp('consumer-next', …)`, and `next build` runs. The exit code is not 0, and the output
  names `useState` and the `/` prerender error.
- `next start`, JavaScript off: the server HTML (via `fetch`) links a `.css` file holding Card's `--card-padding` and
  `.counter[data-v-` rules. `expectStyledCard(page)` passes (computed styles plus the scope attribute). Counter
  `Count 0` sits inside `section.panel`. Button has `extra` plus one `button_` class, red, weight `600` (root props
  through RSC). Tooltip has text-decoration `underline`. Field (subpath) has `display: flex`.
- `next start`, JavaScript on: `body[data-hydrated]` appears, then Counter inside Panel goes `Count 0` → `Count 1`.
  No console error or warning and no page error (`consoleProblems` is `[]`). That covers hydration text and the
  minified `#418` / `#423` / `#425`, all of which arrive as `pageerror` or `error`.
- `next dev` (its own `serveApp` in a nested `describe`, the same app): the same page hydrates, the click counts, and
  there is no console warning or error (dev prints the full hydration texts).

Where: this host (registry reachable, Chromium) and CI's `consumer` job. No new infra: the job already has the
tarballs, Chromium and the store cache.

## Docs

- Milestone doc 6.12: `- Status: done`. Step text edited to what shipped: `@types/node` in the pins,
  `app/layout.tsx` + `app/hydrated.tsx`, the real failure message, the stripped-tarball check. "Hands to later
  milestones": `openPage`'s `javaScript` option.
- `docs/milestones/README.md`, spec, plan, architecture, SETUP.md: no change (they already name the Next.js consumer
  app).

## Fuzzing

None: no cheap oracle. It is one install path.

## Out of scope

- `next build --webpack` (the milestone's risk note: add it only if Turbopack breaks), 6.13, the exit test, a local
  registry, a CSP in the Next app.

## Done when

- `next.spec.ts` passes here and in CI's `consumer` job, and the log shows it running. `pnpm devx check` passes.
- Docs updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
