---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.10
---

# Milestone 1.10: style parity with plugin-vue (the exit test)

## Problem

Milestones 3 and 6 will ship our compiled `<style>` CSS for React and Svelte. Milestone 1 must prove it is the CSS
plugin-vue ships for Vue, after the same Vite CSS steps. Core has every piece (`splitBlocks`, `checkBlocks`,
`createBuildContext`, the style kind's `build`); what is missing is the exit test,
`packages/e2e/build/style-parity.spec.ts`.

Facts this plan rests on (current `main`, checked by running the pipeline once over every valid fixture):

- Vite drops a scoped style module when nothing uses its component: plugin-vue tags scoped blocks with
  `meta.vite.cssScopeTo`, and Vite's css-post skips them unless the bundle keeps the component's default export
  (`node_modules/vite/dist/node/chunks/node.js:22745-22747`). App builds also drop entry exports. So
  `import './X.vue'` or `export {default} from './X.vue'` emit only the global block; the Vue entry must use the
  component: `import Component from './X.vue'; console.log(Component);`.
- Vite joins the CSS of a chunk's modules with `''` (`node.js:22749`, `chunkCSS = (chunkCSS || "") + styles.get(id)`).
  Our SCSS output has no trailing newline, so joining the blocks of `<Name>.ours.css` with `'\n'` differs from
  plugin-vue by one newline on `Panel.ucf`; joined with `''`, as Vite does, it matches.
- A fixture with no non-module block (`Card`, `ReactDefaultSpecifier`, `Hello`) emits no CSS asset from the Vue build;
  our build of an empty `<Name>.ours.css` emits one empty asset. Compared as the joined text of all CSS assets, both
  are `''`.
- plugin-vue `features.componentIdGenerator` as a function sets `descriptor.id` to its return value
  (`dist/index.mjs:59`), so `() => ctx.scopeId` stamps our id.
- `buildApp(root)` (`packages/e2e/build/lib/build.ts:16`) builds under `NODE_ENV=production` but always with the
  app's own `vite.config.ts` (`plugins: [vue()]`); adding a configured `vue()` inline would register plugin-vue twice.

## Plan

1. **`packages/e2e/build/lib/build.ts`**: `buildApp(root: string, config: InlineConfig = {})` merges `config` over
   today's base (`{root, logLevel: 'silent', build: {write: false, minify: false}}`) with Vite's `mergeConfig`.
   Existing callers (`vue-reference.spec.ts`, `scope-id.spec.ts`) pass nothing and behave as today.
2. **`packages/e2e/build/style-parity.spec.ts`** (new), area Build, `describe.each(listComponents())`. Per fixture,
   in `beforeAll` (teardown removes the copy):
   - `root = await copyApp('vue-reference')`; the fixture is copied to `src/<Name>.ucf`;
     `split = splitBlocks(source, join(root, 'src', name))`.
   - `ctx = await createBuildContext(split, {root, compiler, production: true})`, with
     `compiler = createRequire(import.meta.url)('vue/compiler-sfc') as VueCompiler` (the compiler plugin-vue resolves).
   - Writes `src/<Name>.vue`: `<template><div /></template>` plus each non-module `<style>` block verbatim
     (`source.slice(block.start, block.end)`), joined with `'\n'`.
   - Writes `src/<Name>.ours.css`: `getBlockKind('style').build!(block, ctx).code` of the same blocks, joined with
     `''` as Vite joins a chunk's CSS (one-line comment).
   - Writes `src/vue-entry.ts` (`import Component from './<Name>.vue'; console.log(Component);`, with a one-line
     comment on `cssScopeTo`) and `src/ours-entry.ts` (`import './<Name>.ours.css';`).
   - Two real builds through `buildApp(root, {configFile: false, plugins: [vue({features:
     {componentIdGenerator: () => ctx.scopeId}})], build: {cssMinify: false, rolldownOptions: {input}}})`, a fresh
     plugin-vue each; only the entry differs, so both pass the same Vite CSS steps.
   - Tests:
     - **`reports nothing`**: `checkBlocks(split)` is `[]` (it includes `split.errors`), and every
       `ctx.styles[i].errors` is `[]`.
     - **`emits the CSS plugin-vue emits for the same non-module blocks`**: the joined text of the emitted CSS assets is equal. Non-vacuity: with a non-module
       block, the CSS is not empty, and with `ctx.hasScoped` it contains `[data-v-${ctx.scopeId}]`; without one,
       both are `''`.
     - **`maps each module class of the block source to a class of our CSS`**: `ctx.modules` holds one entry per
       module block, by index; for every `ctx.modules[name]`, a non-empty class map whose every key is a class
       selector in the block source and every value a class selector in our CSS of that block
       (`build(block, ctx).code`).
3. No core change: the pipeline already matches.
4. **`packages/e2e/fixtures/index.ts`**: `hasClass(css, name)`, moved from `packages/core/test/styles.spec.ts`, so both
   specs share one copy (review).

## Tests

All on this host and in CI's `check` job (`pnpm devx test`; the `e2e` project is already in the root
`vitest.config.ts`). Needs only root devDependencies already installed (`vite` 8.2.2, `@vitejs/plugin-vue` 6.0.8,
`vue` 3.5.42, `sass` 1.104.0). No new infra: per `docs/milestones/README.md`, the Build area runs real
`vite.build()` inside `pnpm devx test`. Measured: 7 fixtures, 14 builds, about 2 s.

Fails without the step (no spec), and on any CSS drift: a wrong or missing scope attribute, a different SCSS output,
the scope id not reaching plugin-vue (its default id hashes `src/<Name>.vue`), a module block that does not compile.

## Docs

- Milestone doc 1.10 Build line and exit test items 3 and 4 stay as written; they gain the `''` join rule and the
  "the Vue entry uses the component" point (`cssScopeTo`). `- Status: done` as the step's last line.
- Milestone 1 risk 2: the exit test compares `Panel.ucf`'s scoped SCSS through both preprocessor paths and finds no
  difference; `css.preprocessorOptions` still do not reach ours.
- Milestone 3 "Risks and open questions": one entry: plugin-vue's scoped CSS is dropped when its component's default export is not
  kept in the bundle (`cssScopeTo`, Vite `node.js:22745-22747`); our shared style modules carry no such tag, so React and
  Svelte builds would ship scoped CSS of unused components.
- No `spec.md`, `plan.md`, `architecture.md` or `publicdocs/` change: a test only, no behaviour or structure change.

## Fuzzing

None: step 1.10's Test line names none (orchestrator).

## Out of scope

- Any core or Vite plugin change; serving the style modules (milestone 3).
- CSS module class-name parity for the Vue target (risk 1, milestone 4).
- `less` / `stylus` fixtures (risk 8); the `composes … from` crash (its own todo).

## Found while building

- Review: the module class map test asserted nothing when `ctx.modules` was empty; it now pins `ctx.modules` to one
  entry per module block first. `hasClass` was a copy of core's test helper: now shared from the fixture helpers.
- Review, declined: dropping the module class map test as a repeat of core's tests. Exit test item 6 asks for it.

## Decisions

- One `src/<Name>.ours.css`, blocks joined with `''` as Vite joins a chunk's CSS (orchestrator: the milestone doc
  names one file).
- No fuzz test (orchestrator).
- The unused-component scoped CSS note goes to milestone 3's risks, not milestone 1's (orchestrator).
- `buildApp(root, config)` with `mergeConfig`; the Vue entry uses the component; risk 2 outcome line (orchestrator).

## Done when

- `hasClass` shared from `packages/e2e/fixtures/index.ts` by core's style tests and the exit test.
- `packages/e2e/build/style-parity.spec.ts` passes over every name in `listComponents()`: our CSS equals
  plugin-vue's after Vite on every fixture, and every module class map checks out.
- `pnpm devx check` green; milestone 1 doc (1.10, exit test, risk 2) and milestone 3 risks match what shipped; step
  1.10 ends with `- Status: done`.
- Todo `git mv`'d into `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
