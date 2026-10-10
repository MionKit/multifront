---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.7
---

# Milestone 1.7: scopeId with the plugin-vue scheme

## Problem

Every target must stamp the same `data-v-*` id for one `.ucf` file: React (M3) and Svelte (M6) stamp it themselves,
and the Vue target (M4) feeds it to plugin-vue through `features.componentIdGenerator`. So core needs one function
that gives exactly the id plugin-vue gives on its own, in dev and in production. It does not exist yet.

plugin-vue 6.0.8 (`dist/index.mjs:55-60, 110-112`), with no `componentIdGenerator` set:
`descriptor.id = getHash(normalizePath(path.relative(root, filename)) + (isProduction ? source : ''))`,
where `getHash(text) = crypto.hash('sha256', text, 'hex').substring(0, 8)`. `root` is the Vite root, `source` the
raw file text.

## Plan

1. **`packages/core/src/scopeId.ts`** (new):
   `export function scopeId(relativePath: string, source: string, production: boolean): string`
   returns `hash('sha256', relativePath + (production ? source : ''), 'hex').slice(0, 8)` (`hash` from `node:crypto`,
   the call plugin-vue makes). One-line JSDoc: `relativePath` is from the Vite root with `/` separators; for a `.ucf`
   file `source` is the whole file.
   - No path normalizing inside: the input contract says `/` separators, and the caller computes it
     (`createBuildContext`, 1.9). On Linux `\` is a legal filename char, so rewriting it would drift from plugin-vue.
   - `node:crypto` is the first Node built-in in core. Core stays bundler agnostic (no Vite, no framework plugin);
     `tsconfig.base.json` already has `types: ["node"]`, root `engines.node >= 26` has `crypto.hash`.
2. **`packages/core/src/index.ts`**: `export {scopeId} from './scopeId.ts';`.
3. **`packages/e2e/build/lib/build.ts`** (new, area helper per milestones README "Test helpers live in
   `<area>/lib/`"): `buildApp(root)` runs the production `vite.build()` that `vue-reference.spec.ts` runs today
   (`NODE_ENV=production` around it, `logLevel: 'silent'`, `build: {write: false, minify: false}`) and returns
   `{chunks, cssAssets}` (CSS sources decoded to string). Beside it, `exportedScopeId(code)` reads the `__scopeId`
   value out of a component module (dev or build), the regex `vue-reference.spec.ts` had inline.
   `vue-reference.spec.ts` switches to both, its checks unchanged.
   1.10 reuses it. Not run by Vitest (`include` is `build/**/*.spec.ts`), checked by `packages/e2e/tsconfig.json`
   (`include` has `build`).
4. **Milestone doc**: step 1.7 gets `- Status: done`. Step text and "Hands to later milestones" already match.
5. **`docs/spec.md`** 3.3 Scope id: "relative to the package root" becomes "relative to the Vite root".

## Tests

`packages/e2e/build/scope-id.spec.ts` (area **Build**), real plugin-vue with no `componentIdGenerator`, on a fresh
`copyApp('vue-reference')` (cleanup returned from `beforeAll`). Expected values read `src/Reference.vue` from the copy.

- **production**: `buildApp(root)`; the single `__scopeId` `data-v-<hex>` in the JS chunk, and every `data-v-` in the
  CSS asset, equal `'data-v-' + scopeId('src/Reference.vue', source, true)`.
- **development**: `createServer({root, logLevel: 'silent', server: {middlewareMode: true, ws: false}})` (app's own
  `vite.config.ts`), `server.transformRequest('/src/Reference.vue')`; the `__scopeId` value equals
  `'data-v-' + scopeId('src/Reference.vue', source, false)`. Server closed in `finally`. Vitest's `NODE_ENV=test`
  gives plugin-vue `isProduction: false`, the dev path.
- Also: the dev and production ids differ, so the test cannot pass if `production` were ignored.
- Fails without `scopeId` (import error), or with any drift from plugin-vue's scheme (wrong hash, length, input
  order, ignored `production`).
- Runs on this host and in CI's `check` job (`pnpm devx test`). Needs Node + root devDependencies only (vite,
  plugin-vue, vue, sass: all in from 1.1). No browser, no new CI step.
- `pnpm devx typecheck` covers the new source, helper and spec.

## Docs

- `docs/spec.md` 3.3, as in Plan 5.
- `docs/plan.md`: none, "Building on plugin-vue" point 4 and the M1 summary already state this scheme.
- `docs/architecture.md`: none, no structure change (one file in core).
- `publicdocs/`: none, no page describes scope ids yet; the milestone docs writer covers it.

## Fuzzing

None. Only cheap oracle: random paths and sources against plugin-vue's own `getHash` (handed to a
`componentIdGenerator` function as its 4th arg). That compares sha256 with sha256; the two real plugin-vue checks
already pin the input shape, which is where drift could come from.

## Decisions

- Spec 3.3 says "Vite root", like the milestone step, plan.md and plugin-vue (orchestrator, decision rule 1).
- One shared `build/lib/build.ts` for the production build, `vue-reference.spec.ts` moved onto it with its checks
  unchanged (orchestrator, decision rule 1).
- No fuzz test (orchestrator agreed).

## Out of scope

- Computing `relativePath` from a filename and root (`createBuildContext`, 1.9).
- Setting `componentIdGenerator` in our Vite plugin (M4), stamping ids (M3, M6).
- CSS module class names (1.8).

## Done when

- `scopeId` exported from `@multifront/core` with the shape above.
- `scope-id.spec.ts` passes both modes on this host and in CI; `vue-reference.spec.ts` still passes on the helper.
- `docs/spec.md` 3.3 says Vite root; milestone step 1.7 marked `- Status: done`.
- `pnpm devx check` green.
- The simplify-comments pass ran on every touched source file, committed on its own.
