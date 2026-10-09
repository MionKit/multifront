---
type: feature
spec: full-plan
status: done
created: 2026-10-09
milestone: 1
step: 1.1
---

# Milestone 1.1: the packages/e2e package and the Vue reference app

## Problem

Milestone 1 and every later milestone test the real thing end to end, in one private workspace package,
`packages/e2e`. It does not exist yet: no shared fixture helpers, no app fixture. Steps 1.2 to 1.10 need all of it,
plus a plain Vue app as the yardstick: what plugin-vue does on its own.

## Plan

1. **Root devDependencies**, exact pins (`pnpm add -Dw`), lockfile updated in the same commit:
   - `@vitejs/plugin-vue` 6.0.8, `vue` 3.5.42: the same versions `packages/vite/package.json` carries.
   - `sass` 1.104.0 (newest older than the 30 day release age, published 2026-09-03). Comes here, not in 1.8:
     `Reference.vue` has a `<style scoped lang="scss">` block and Vite cannot build it without `sass`.
2. **`packages/e2e/package.json`**: `"name": "@multifront/e2e"`, `"version": "0.0.0"`, `"private": true`,
   `"type": "module"`, description, `"license": "MIT"`. `dependencies`: `@multifront/core` and `@multifront/vite`,
   both `workspace:*`. No `exports`, no `files`, no build scripts.
3. **Folders**: `build/`, `browser/`, `editor/`, `consumer/`, `fixtures/components/`, `fixtures/apps/`. Each folder
   still empty after this step holds a `.gitkeep` (`browser/`, `editor/`, `consumer/`, `fixtures/components/`).
4. **`packages/e2e/vitest.config.ts`**, shaped like `packages/core/vitest.config.ts`: `resolve.conditions` and
   `ssr.resolve.conditions` `['source']`; `test`: `name: 'e2e'`, `environment: 'node'`,
   `include: ['{build,browser,editor,consumer}/**/*.spec.ts']`, `testTimeout: 60_000`.
5. **`packages/e2e/tsconfig.json`** (check only): extends `../../tsconfig.base.json`, `noEmit: true`,
   `include: ['build', 'browser', 'editor', 'consumer', 'fixtures/index.ts', '*.config.ts']`. No `tsconfig.build.json`.
   `devx typecheck` already runs `tsc -p` on every package's `tsconfig.json` (`scripts/devx.mjs:42`); `checkTree()`
   (`scripts/devx.mjs:24`) skips the root reference for private packages but still requires the vitest project entry.
6. **Root `vitest.config.ts`**: add `'packages/e2e/vitest.config.ts'` to `projects`. Root `tsconfig.json` unchanged.
7. **`packages/e2e/fixtures/index.ts`**: only `copyApp(name)`, the helper this step's test calls. It does
   `mkdir` `packages/e2e/.tmp/`, `mkdtemp(join(tmp, name + '-'))`, `cp(fixtures/apps/<name>, dest, {recursive: true})`,
   returns `dest`. A missing app removes the temp folder and rethrows the real ENOENT. `FIXTURES_DIR`,
   `componentPath`, `readComponent`, `listComponents` moved to step 1.2 with their first fixtures and callers.
8. **`.tmp/` ignored**: `.gitignore` gets `.tmp/`; `.oxlintrc.json` and `.oxfmtrc.json` `ignorePatterns` get
   `**/.tmp/**`, so a copy left by a failed run is never linted or format-checked.
9. **`packages/e2e/fixtures/apps/vue-reference/`**, plain Vue, no multifront:
   - `index.html` (`<div id="app">`, loads `/src/main.ts`), `vite.config.ts` (`defineConfig({plugins: [vue()]})`),
     `src/main.ts` (`createApp(Reference).mount('#app')`), `src/env.d.ts` (the `*.vue` shim, `DefineComponent`).
   - `src/Reference.vue`: `<template>` using the scoped classes and `$style.note`; `<style scoped>` with `.title`;
     `<style module>` with `.note`; `<style scoped lang="scss">` with a `$gap` variable and a nested rule
     (`.box { .inner {…} }`).
10. **Docs**: `SETUP.md` one line under Commands (`pnpm devx test packages/e2e/build` runs one e2e area);
    `docs/plan.md` Packages table row for `packages/e2e` (private, never published: cross-package e2e tests by area
    and the shared fixtures; milestone 1); `packages/AGENTS.md` one line: `e2e` is private, never built,
    `tsconfig.json` only (the one exception to the two-tsconfig rule); milestone doc: step 1.1 `- Status: done`,
    its Build line names `sass` and only `copyApp`, step 1.2 gets the `.ucf` helpers, step 1.8's "Root devDependencies" line drops `sass` (already installed).

## Tests

- `packages/e2e/build/vue-reference.spec.ts` (area **Build**). Runs on this host and in CI's `check` job
  (`pnpm devx test`); needs Node and the root devDependencies only, no browser, no extra CI step
  (Vite builds already run in `packages/vite/test`).
  - `beforeAll`: `root = await copyApp('vue-reference')` (the real build on a fresh copy, so `copyApp` is exercised);
    the cleanup (`rm(root, {recursive: true, force: true})`) is returned from `beforeAll`, so it runs only after
    a successful copy.
  - `vite.build({root, logLevel: 'silent', build: {write: false, minify: false}})`: Vite finds the app's own
    `vite.config.ts` in `root`, with the real plugin-vue. `NODE_ENV` is set to `production` around the build:
    Vitest sets it to `test` and Vite keeps it, which would give plugin-vue's dev scope id (path only).
  - Checks: exactly one output chunk, containing `__scopeId` paired with a `data-v-<hex>` value; exactly one `.css`
    asset; its `.title` and SCSS (`.box`, `.box .inner`) rules carry `[data-v-<same hex>]`; no other `data-v-` id
    in the CSS; the `<style module>` class rule is present without a scope attribute.
  - Fails without the package (no file), its project entry (vitest never runs it, and `devx typecheck` fails in
    `checkTree`), or the app (`copyApp` throws).
- `pnpm devx typecheck` covers `fixtures/index.ts` and the spec.

## Docs

- `SETUP.md`, `docs/plan.md` (Packages table), `packages/AGENTS.md`, the milestone doc: as in Plan 10.
- Root `AGENTS.md`: the new-package rule says the root `tsconfig.json` reference is for published packages only,
  matching `checkTree()`.
- `docs/architecture.md`: none; it describes the runtime code layout, which a test package does not change.
- `publicdocs/`: none; no user-facing behaviour.

## Fuzzing

None: test infrastructure and a fixture, no logic with an oracle.

## Decisions

- `sass` (exact 1.104.0) becomes a root devDependency in 1.1 instead of 1.8: the scoped SCSS block the step requires
  cannot build without it. 1.8's step text updated to match (orchestrator confirmed).
- Review: the `.ucf` helpers had no caller or test in 1.1, so they moved to 1.2 (milestone doc updated).
- Review: the build runs with `NODE_ENV=production`, so the yardstick's scope id is a real build's.
- Review: the unused `workspace:*` dependencies on core and vite stay; the step text asks for them.
- Review: `src/env.d.ts` stays; the step lists it, and it serves an editor opening the app.
- The build test runs on a `copyApp` copy, not the fixture folder in place, so nothing is written next to fixtures.

## Out of scope

- Component fixtures (`*.ucf`) and the `.ucf` helpers (1.2). Any core code. `scopeId` (1.7).
- Browser, editor, consumer tests and their CI infra (M2, M3, M5).

## Done when

- `pnpm devx test` runs the `e2e` project; `vue-reference.spec.ts` passes on this host and in CI.
- `pnpm devx typecheck` passes with the new package; `pnpm devx check` is green.
- `copyApp()` exists with the shape above; docs updated; milestone step marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
