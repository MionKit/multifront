---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.7
---

# Milestone 3.7: Post plugin moves the import attribute into the id

## Problem

`multifront()` returns only the pre plugin (`packages/vite/src/index.ts:152`). Nothing rewrites `with { framework }`,
so the pre plugin's `resolveId` never sees the attribute: `main.ts`'s `with {framework: 'react'}` falls back to the
importer and default rules, `mixed.ts` gets one framework for both imports, and the `import()` options reach the
browser and Node (spike 3, answer 2). Spec 4.4 is not built.

## Plan

### 1. `packages/vite/src/attributes.ts`: the plugin `multifront:attributes`

- `attributesPlugin(options: MultifrontOptions): Plugin`, `name: 'multifront:attributes'`, `enforce: 'post'`.
- `transform` hook filter: `id: /\.(?:[cm]?[jt]sx?|vue|svelte)(?:\?|$)/` (`.js .mjs .cjs .ts .mts .cts .jsx .tsx
  .vue .svelte`, with or without a query; `.mts` since `importers` may name it), `code: /\.ucf/`.
- Handler: `rewriteImportAttributes(code, id)` (`packages/core/src/imports/rewrite.ts:62`).
  - `errors` not empty: report the first (`framework-attribute-not-literal`) and stop there, no `resolveTarget`
    call (else the same import is also `no-target`).
  - Else, per `imports` entry: `resolveTarget(importerFromId(id), entry.framework, options)`; an error is reported at
    `entry.start` (the specifier literal), message `<specifier> (imported by <importer file>): <message> (<code>)`,
    the text `resolveId` builds today (`index.ts:108`), moved to `diagnostics.ts` as
    `importErrorMessage(specifier, importerFile | undefined, error)` and used by both. In a build Rolldown gives
    `resolveId` no position, so only the transform can locate the import. The rules stay in `resolveTarget`.
  - Returns `{code, map}` when `map` is not null, else `undefined`.
- `resolveId` keeps its own error path for imports the transform never sees (hand-written `?framework=`, `.ucf`
  entries, block imports) and `missing-target-block` (needs the split).
- Reporting at an offset of the code the transform got (already compiled by Oxc / plugin-react):
  - dev (`this.environment.mode === 'dev'`): `this.error(message, offset)`; Vite's dev container maps the position
    back through the combined source map itself. A mapped `loc` would be mapped a second time.
  - build: Rolldown does not map, so `originalPositionFor(new TraceMap(this.getCombinedSourcemap()), ...)`, then
    `this.error({message, loc: {file, line, column}})`; unmapped falls back to the current position.
- One problem per error: the first of the file.
- `@multifront/vite` `dependencies` gain `@jridgewell/trace-mapping` `0.3.31`, exact-pinned (the root's version).

### 2. `packages/vite/src/index.ts`

- `return [pre, attributesPlugin(options)]`; `resolveId` uses `importErrorMessage`, behaviour unchanged.

### 3. Fixtures (`packages/e2e/fixtures/apps/imports/`)

- `no-default/ssr-entry.tsx`: imports `react-dom/server` and `Card.ucf` with `framework: 'react'` (line 2),
  exports `render()` returning `renderToString(<Card title="Hello" />)`.
- `expected.ts`: row `{file: 'no-default/ssr-entry.tsx', specifier: CARD, line: 2, options: NO_DEFAULT,
  expect: 'react', rule: 'attribute'}`; core `resolveTarget.spec.ts`, language-tools `resolve.spec.ts`,
  `editor/tsserver.spec.ts` run it; `rewrite.spec.ts` gets one new JSON snapshot.
- `vite.config.ts` per sub-project, `defineConfig({plugins: [react(), multifront(<options>)]})` with the options of
  its `tsconfig.json` plugin entry: `imports/` (`{framework: 'react'}`, serves `src/`), `no-default/`
  (`{importers: {'.mts': 'vue'}}`), `custom-importers/` (`{importers: {'.ts': 'svelte', '.tsx': 'vue'}}`),
  `react-only/` (`{frameworks: ['react']}`).
- The configs are no importers: left out by name in `packages/core/test/imports/resolveTarget.spec.ts`
  (`APP_FILES`) and `packages/core/test/imports/rewrite.spec.ts` (`filesOf`).
- Root `devDependencies` gain `@types/react-dom` `19.3.0`, exact-pinned (same as `@multifront/vite`'s `react-dom`).

### 4. `packages/e2e/build/imports.spec.ts` (area: build)

- A row's sub-project: the nearest `vite.config.ts` above its file, loaded with `APP_CONFIG_LOADER`.
- Rows in scope: `.js`, `.ts`, `.mts`, `.tsx`, `.jsx`, `.vue`, `.ucf` (`no-default/plain.js` with the attribute and
  `no-default/importer.mts`, vue through `importers`, added with their rows; `vue()` in the root config for
  `Page.vue`). `.svelte` rows wait for M6 (`svelte()` in these configs). `strings-and-comments.ts` has zero `.ucf` references.
- A helper lists every module reference of an output with `parseAst`: import / export declarations, `import()`,
  and in SSR code `__vite_ssr_import__` / `__vite_ssr_dynamic_import__`, with their attributes / options.
- **Dev**: one server per sub-project (middleware mode, `ws: false`, `server.preTransformRequests: false`,
  `optimizeDeps.noDiscovery`). Each target-row file through `transformRequest` in `client` and `ssr` (a `.ucf` row
  through its `.ucf.react.tsx` module): its `.ucf` references in source order (less Fast Refresh's import of the
  module itself) match its rows in line order, path before `?` = `<Card>.react.tsx` / `/@fs<Card>` /
  `<Card>.svelte.svelte` (Vite writes `/@fs` only before a file on disk), no `framework` in the query; no reference
  has an attribute or options with `with` / `framework`.
- A guard: every `.ts`, `.tsx`, `.jsx`, `.ucf` file of the app is a row file or `strings-and-comments.ts`.
- **SSR**: `ssr-entry.tsx` through `server.environments.ssr.runner.import()`, `render()` gives
  `<div class="<card>"><h2>Hello</h2></div>` with `<card>` from core `createBuildContext` (same root, dev).
- **Build**: per sub-project with react rows, one `buildApp` over every file whose rows are all react; `moduleIds`
  hold `<Card>.react.tsx`, no output reference has attributes or `with` / `framework` options.
- **Error rows**, dev and build: message has `(<code>)`; `loc` = `{file, line: row.line, column}` from the raw
  source (the rewrite's error, else the import's `start`); `src/BlockAttribute.ucf` gives both `framework-in-block`
  diagnostics of `checkBlocks`, the first as `loc`, the second as a `file:line:column` message line.
- Runs on this host and the CI `check` job (`pnpm devx test`); no new infra.

### 5. Docs

- `docs/milestones/m3-react-and-imports.md` 3.7 to what shipped, `- Status: done`; hand-off: `build/imports.spec.ts`
  and the sub-project `vite.config.ts` files, M4 builds the `.vue` rows, M6 adds `svelte()` and the `.svelte` rows.
- `docs/spec.md` 4.4: the post plugin reports a non-literal attribute and the target rules' errors at the import,
  in the importer's source.
- `publicdocs/07-errors.md` "Import Errors": row `framework-attribute-not-literal`.
- `docs/architecture.md`, `docs/plan.md`: none.

## Fuzzing

None: the plugin is a thin host around `rewriteImportAttributes`, whose properties core's `rewrite.spec.ts` checks.

## Out of scope

- `.svelte` importers (M6), building `.vue` rows (M4). A `loc` for `missing-target-block` in a build (stays a `resolveId` error).
- The TypeScript plugin (3.8), browser tests (3.9).

## Decisions

Orchestrator's answers to the plan:

- The post transform also calls `resolveTarget` per import and reports at the import, mapped back to the source:
  3.7's "Error rows fail with their code and location"; a second caller, not a copy of the rules.
  `@jridgewell/trace-mapping` as an exact-pinned dependency of `@multifront/vite` is fine.
- The four `vite.config.ts` files are left out of core's importer listings by name: they are no importers.
- The `framework-attribute-not-literal` row joins `publicdocs/07-errors.md` now.
- Review (automatic), fixed: commits split by concern; `keyName` shared from `build/lib/build.ts`; core exports
  `locate`, used by the plugin and the test; Rolldown's error types; one react-file list; `.js` / `.mts` rows; the
  error codes compared with the rows; the `Page.vue` row in dev (`vue()` in the root config); `filesOf` shared in
  `fixtures/index.ts`; smaller nits.
- Review, kept: the unmapped-`loc` fallback has no test (no real tool gives a transform output with an unmapped
  import); the post transform reports rule errors for externalized `.ucf` imports too (the rules apply to every
  `.ucf` import an app writes).
- The `.svelte` row waits for M6 (orchestrator): Svelte is M6's target, and its plugin is that milestone's work, not
  test infra.

## Done when

- `imports.spec.ts` passes in dev, SSR and build; the `resolveTarget`, `rewrite`, `resolve` and `tsserver` specs
  pass with the new row; `pnpm devx check` passes.
- Milestone 3.7 ends with `- Status: done`; later text and hand-offs match what shipped.
- This todo moved to `docs/done/`, matching what shipped.
- The review ran and its findings are fixed.
- The simplify-comments pass ran on every touched source file, committed on its own.
