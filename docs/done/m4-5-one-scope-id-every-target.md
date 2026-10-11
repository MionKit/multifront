---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.5
---

# Milestone 4.5: one scope id for every target (componentIdGenerator + CSS module names)

## Problem

A `.ucf` file built as Vue gets other ids than the same file built as React. Checked on plugin-vue 6.0.8 and Vite 8.2.2
with a scratch build of `apps/vue`:

- **`data-v-*`**: plugin-vue's `createDescriptor` (`dist/index.mjs:49-60`) hashes
  `getHash(relativePath + (production ? source : ''))`, where `source` is the SFC code our pre transform returns, not the
  raw `.ucf`. In production its id differs from `ctx.scopeId` (`packages/core/src/context.ts:19`), which hashes the raw
  source. In dev both hash the path only, so they agree by chance. `features.componentIdGenerator(normalizedPath, source,
  isProduction, getHash)` is the hook; plugin-vue's `configResolved` spreads `options.value`, so `features` set before
  it is kept.
- **CSS module class names**: plugin-vue hands `<style module>` to Vite's CSS modules as
  `Card.ucf?vue&type=style&index=N&lang.module.css`. postcss-modules names classes there (Vite default
  `_<local>_<hash5>_<line>`), while our React target uses M1's `<local>_<scopeId>_<index>`
  (`packages/core/src/styles.ts:91`). postcss-modules calls `css.modules.generateScopedName(local, from, css)` with
  `from` = the full id, query included. Writing `config.css.modules` in `configResolved` works (not frozen, every
  environment reads it). A function `generateScopedName` has no fallback in postcss-modules, so keeping other files'
  names means calling the user's generator, or Vite's default when none is set, ourselves.

## Decisions

- Step text "`$style.counter`" becomes "`$style.button`": `Counter.ucf`'s module class is `button` (`counter` is its
  scoped class).
- Q1 (orchestrator): add `generic-names` 4.0.0 (exact pin, `@multifront/vite` `dependencies`, the version Vite 8.2.2
  bundles, released 2021-12-22 so the 30-day gate passes) for a user's string pattern, and copy postcss-modules'
  default generator. Copying only the default would break a user's string pattern for every other file.
- Q2 (orchestrator): `composes … from './other.css'` in a `.ucf` `<style module>` is accepted for now, as a Risks line:
  postcss-modules passes only the composed file's path, so its classes keep Vite's or the user's names in the Vue target.
- Q3 (orchestrator): `css.transformer: 'lightningcss'` is accepted for now, as a Risks line: Vite ignores
  `css.modules`, so `.ucf` Vue classes get lightningcss names.
- No fuzz test: the new inputs are configs and generator options, no cheap oracle beyond the fixture equality.
- The tests pair each user `componentIdGenerator` with one user `css.modules` setting (four rows), so every variant
  runs once in production and once on the dev server without a build per combination.

## Plan

### 1. Core: one home for the relative path and the class name scheme

- `packages/core/src/scopeId.ts`: `rootRelativePath(root, filename)` (today inline in `context.ts:11`);
  `createBuildContext` uses it.
- `packages/core/src/styles.ts`: `moduleClassName(local, scopeId, index)`; `modulesOptions` (`:91`) uses it.
- Both exported from `packages/core/src/index.ts`.

### 2. `packages/vite/src/cache.ts`

- `sourceOf(file): string`, synchronous: the current version's raw source, else `readFileSync` + store. plugin-vue's
  generator is synchronous.

### 3. `packages/vite/src/vueTarget.ts`

- `composeVuePlugin(config: ResolvedConfig, scopeIdOf: (file: string) => string)` replaces `composeVuePlugin(plugins)`;
  still returns when plugin-vue is absent. Include + exclude as today, then the generator, then CSS modules.
- Component id generator `(path, source, production, getHash)`: a `.ucf` path returns
  `scopeIdOf(normalizePath(resolve(config.root, path)))`, ignoring the SFC code; else the user's function, `'filepath'`
  (`getHash(path)`), `'filepath-source'` (`getHash(path + source)`), or plugin-vue's default
  (`getHash(path + (production ? source : ''))`). A module-level `WeakMap<ours, user's>` unwraps our previous one on a
  repeat `configResolved` (`server.restart()` reuses plugin instances).
- CSS modules, unless `config.css.modules === false`: `config.css.modules = {...modules, generateScopedName}`, a new
  object, so the user's inline config is never mutated. A `.ucf` path with a `vue` query and `type=style` returns
  `moduleClassName(local, scopeIdOf(path), index)`; anything else goes to `viteScopedName(modules)`.

### 4. `packages/vite/src/cssModules.ts` (new)

- `viteScopedName({generateScopedName, hashPrefix})`: the user's function; a string pattern through `generic-names`
  with `{context: process.cwd(), hashPrefix}` as postcss-modules 9.0.1 calls it; unset → postcss-modules' default
  `_${local}_${stringHash(hashPrefix + css).toString(36).slice(0, 5)}_${line}`.

### 5. `packages/vite/src/index.ts`, `types.ts`

- `configResolved`: `composeVuePlugin(resolved, ucfScopeId)`, with
  `ucfScopeId(file) = scopeId(rootRelativePath(config.root, file), cache.sourceOf(file), config.isProduction)`: the
  inputs `createBuildContext` hashes, read from the live config.
- `VuePluginApi.options` gains `features?: Options['features']`.

### 6. Fixture

- `fixtures/apps/vue/src/Plain.vue` gains a `<style module>` (`.note`) used as `$style.note`.

## Tests

Host + CI `check` job (`pnpm devx test`): real `vite.build()` and in-process dev servers. No new infra.

`packages/e2e/build/vue-scope-id.spec.ts` (`copyApp('vue')`, `copyApp('demo')`; both see
`../../components/Counter.ucf`):

1. Counter as Vue and as React, production and dev server: same `data-v-X` (CSS selector, Vue `__scopeId`, React
   stamp), equal to `scopeId(path, source, production)`; same `button_X_1` module class in CSS and JS.
2. Four rows, each a user `componentIdGenerator` (unset, `'filepath'`, `'filepath-source'`, a function) paired with a
   user `css.modules` (unset, `{hashPrefix}`, a string pattern, a function): `Plain.vue` keeps its `__scopeId` (production
   and dev server) and its `.note` class with and without `multifront()`; Counter keeps `data-v-X` and `button_X_1`.
3. After `server.restart()`: Counter still `data-v-X` and `button_X_1`.

## Docs

- `docs/plan.md` "Building on plugin-vue" item 4: the class names.
- `docs/spec.md` 3.4: one line on matching class names.
- Milestone doc: `$style.button`, Hands row for `vueTarget.ts`, two Risks lines, `- Status: done`.

## Out of scope

- HMR (4.9), cache-miss warm-up (4.7), browser parity (4.11), deduplicating plugin-vue's CSS with ours.
- `css.transformer: 'lightningcss'` and `composes … from` files (Decisions).

## Done when

- `vue-scope-id.spec.ts` passes; `pnpm devx check` is green.
- Step 4.5 has `- Status: done`; the docs above are updated; this todo is in `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
