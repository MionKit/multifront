---
type: feature
spec: full-plan
status: ready
created: 2026-10-10
milestone: 3
step: 3.6
---

# Milestone 3.6: Vite plugin resolves and loads the React target

## Problem

`multifront()` (`packages/vite/src/index.ts:11`) is one pre plugin that only lends the Vue compiler. An app writing
`import AllBlocks from './AllBlocks.ucf'` in a `.tsx` file cannot build: nothing resolves `.ucf` imports to the ids of
spec 4.3, nothing serves `Card.ucf.react.tsx`, the style CSS or the class maps, and Vite's dependency scanner fails on
the React id (spike 3, check 2). Core has `react.check` / `react.build` (3.4, 3.5) but no host function that runs a
target row.

## Plan

### 1. Core: `buildTarget` and `DiagnosticsError`

- `packages/core/src/diagnostics.ts`: `export class DiagnosticsError extends Error {diagnostics: Diagnostic[]}`,
  message = the first diagnostic's message.
- `packages/core/src/blocks/index.ts`, beside `checkBlocks`:
  `buildTarget(split: SplitResult, ctx: BuildContext, target: Target): VirtualFile`. Throws `DiagnosticsError`:
  - no `split.targets[target]` → `missing-target-block` at offset 0, `"<file> has no <react> block"`;
  - the kind has no `build` → `target-not-built` on the block's opening tag, `"multifront does not build <vue> blocks yet"`;
  - else errors = `split.errors` + `kind.check(block, split)`; any → throw; none → `kind.build(block, ctx)`.
  - Style errors (`style.check`, `ctx.styles[i].errors`) are not here: the style module that owns them reports them
    (one problem, one error). Other target blocks' checks are not run: only the chosen target is built.
- `packages/core/src/imports/resolveTarget.ts`: `missingTargetBlockMessage(importerFile, ucfFile, target)`, moved
  word for word from `packages/language-tools/src/resolve.ts:84-86` with its `importPath` helper
  (`"../Card.ucf has no <react> block; App.tsx imports it as react"`). language-tools calls it, so build and editor
  print the same text (its tsserver tests pin the text, unchanged).
- `index.ts` exports `buildTarget`, `DiagnosticsError`, `missingTargetBlockMessage`.

### 2. `packages/vite/src/cache.ts`

- `createUcfCache(contextOptions: () => BuildContextOptions): UcfCache`,
  `UcfCache = {splitUcf(file): Promise<SplitResult>; loadUcf(file): Promise<UcfEntry>}`, `UcfEntry = {split, ctx}`
  (both in `packages/vite/src/types.ts`).
- Each call reads the file; same content reuses the split and, for `loadUcf`, one `createBuildContext` promise; new
  content = new split, no context. `splitUcf` serves `resolveId` (no style compile there). Options are read lazily:
  the compiler is borrowed only after plugin-vue's `buildStart`. 3.15 updates it from `hotUpdate`.

### 3. `packages/vite/src/index.ts`: `multifront(options): Plugin[]`

- Returns `[pre]` (3.7 appends `multifront:attributes`). The pre plugin keeps name `multifront`, `enforce: 'pre'`,
  `api.vueCompiler`, the `framework`-not-enabled throw; `frameworks` defaults to all three.
- `MultifrontOptions` (`types.ts`) gains `importers?: Record<string, Target>`; all three go to `resolveTarget`.
- Context options: `root = config.root`, `production = config.isProduction`, `compiler = api.vueCompiler`.
- `config` hook: `{optimizeDeps: {rolldownOptions: {plugins: [scanPlugin]}}}`; `scanPlugin` (`multifront:scan`)
  `load` with filter `/\.ucf\.react\.tsx$/` reads the `.ucf` and returns `{code: <react> block content, moduleType:
  'tsx'}` (`''` without the block).
- `resolveId` (hook filter `/\.ucf/`), `[path, query]` split at `?`:
  - our target ids (`path` ends in `.ucf.react.tsx` / `.ucf.svelte.svelte`, as a dev URL `/src/X…` or absolute):
    `this.resolve(<the .ucf path>, importer, {skipSelf: true})` + the suffix;
  - path ends in `.ucf` and the query is empty or only `framework`: `this.resolve(path, importer, {...options,
    skipSelf: true})`; unresolved → `null`; external → as is. Then `resolveTarget(importer ? importerFromId(importer) :
    undefined, query.get('framework') ?? undefined, options)`, then `splitUcf(file)` must have that block. Returns
    `file + '.react.tsx'`, bare `file` (vue), `file + '.svelte.svelte'`;
  - any other query (`?ucf&type=style…`, `?raw`): `undefined`, so Vite resolves path + query itself (our style and
    class map ids pass through this way);
  - errors: `this.error` with message and code; a `resolveTarget` error prefixed with the specifier and the importer;
    `missing-target-block` uses the core message;
  - scan (`options.scan`): a react pick returns the react id (served by the scan plugin); a vue / svelte pick or any
    error returns `{id: file, external: true}`, no error: the real pipeline reports it.
- `load` (hook filter `/\.ucf/`):
  - `?ucf&type=style&index=N&lang.css`: `loadUcf`; errors = `style.check(block)` + `ctx.styles[N].errors`; else
    `{code, map}` of `ctx.styles[N]`;
  - `…&module&lang.js`: `export default <JSON of ctx.styles[N].classes ?? {}>;`;
  - react id: `buildTarget(split, ctx, 'react')`, `this.addWatchFile(file)`, `{code, map}`;
  - bare `X.ucf` (no query) or `X.ucf.svelte.svelte`: `buildTarget(…, 'vue' | 'svelte')` → `target-not-built`
    (M4 drops vue, M6 deletes the code).
- Errors: `packages/vite/src/diagnostics.ts` `rollupError(diagnostics)`: first diagnostic gives `loc: {file, line,
  column}` and `id`; message `<message> (<code>)`, plus one `file:line:column <message> (<code>)` line per other one.
  `DiagnosticsError` from core goes through it; any other throw passes on.

### 4. Peers (`packages/vite/package.json`)

- `peerDependencies`: `@vitejs/plugin-react ^6.0.0`, `react ^19.0.0`, `react-dom ^19.0.0`, all optional in
  `peerDependenciesMeta`.
- `devDependencies` (satisfying those peers, like plugin-vue): `@vitejs/plugin-react 6.1.1`, `react 19.3.0`,
  `react-dom 19.3.0` (the root's; react-dom 19.3.0 published 2026-09-09, past 30 days; plugin-react 6.1.2 is not).
- Root `devDependencies` gain `react-dom 19.3.0`: the fixture's `main.tsx` mounts with `react-dom/client`. 3.7 then
  adds only `@types/react-dom`.

### 5. Existing tests for the array

- `packages/vite/test/vueCompiler.spec.ts:37`: `probe([...multifront(), vue()])`.
- `packages/e2e/build/build-context.spec.ts:24`: `const [mf] = multifront()`.

### 6. Test infra: fixture `vite.config.ts` loads `@multifront/vite` from source

- Vite's `bundle` and `runner` config loaders resolve `@multifront/vite` to `dist/` (stale, missing in CI where tests
  run before `pnpm devx build`). Only `configLoader: 'native'` under Node `--conditions=source` loads `src/`.
- `packages/e2e/vitest.config.ts`: `test.execArgv: ['--conditions=source']` (root `vitest.config.ts` if vitest takes
  it only there). No third-party package in the store has a `source` condition; e2e child processes use `spawn`,
  which does not inherit execArgv.
- `packages/e2e/build/lib/build.ts` `buildApp`: base config gains `configLoader: 'native'`.
- `docs/milestones/README.md` "Test infrastructure": row "Fixture configs from source | M3 (3.6) | native config
  loader + `--conditions=source` in the e2e worker".

### 7. Fixtures

- `packages/e2e/fixtures/components/imports/Icon.ucf`: `<react>` (`<svg>` with `className={$style.icon}`, text
  `icon-react-marker`), `<style module>` `.icon`.
- `imports/UsesIcon.ucf`: `<react>` `import Icon from './Icon.ucf'` (no attribute), renders
  `<span className="uses-icon"><Icon /> uses-icon-react-marker</span>`; global `<style>` `.uses-icon`. M4, M6 add
  their blocks.
- `packages/e2e/fixtures/apps/react-basic/`: `index.html`; `vite.config.ts` `defineConfig({plugins: [react(),
  multifront()]})`; `src/main.tsx` (`StrictMode` from `react`, `createRoot` from `react-dom/client`, AllBlocks
  `../../../components/react/AllBlocks.ucf` and UsesIcon rendered into `#app`); `src/errors/missing-block.tsx`
  (imports `imports/VueOnly.ucf`), `src/errors/no-default.tsx` (imports `react/errors/NoDefault.ucf`),
  `src/errors/vue-pick.ts` (imports `react/AllBlocks.ucf?framework=vue`: the form 3.7's rewrite emits).

## Tests

All on this host and the CI `check` job (`pnpm devx test`). No Chromium. New infra: section 6 only.

- `packages/e2e/build/react-target.spec.ts` (new, area build). `buildApp(root, {build: {sourcemap: true}})` on
  `react-basic` in place (write: false):
  - the JS chunk's `moduleIds` include `AllBlocks.ucf.react.tsx`, `UsesIcon.ucf.react.tsx`, `Icon.ucf.react.tsx`, and
    the code has their react markers (only UsesIcon imports Icon, with no attribute: the block rule, 4.1);
  - no `all-blocks-vue-marker` / `all-blocks-svelte-marker` in any chunk or CSS;
  - exactly one CSS asset; for each `<style>` of AllBlocks, Icon, UsesIcon, the first selector of its compiled code
    (core `createBuildContext` with the same root, `production: true`) appears in it exactly once;
  - source map: `all-blocks-react-marker`'s chunk position, through `TraceMap(chunk.map)`, lands in a source ending
    `components/react/AllBlocks.ucf`, at the marker's line in that file;
  - error entries (`build.rolldownOptions.input`), each rejected: `missing-block.tsx` → `missing-target-block`, the
    message names `VueOnly.ucf` and `missing-block.tsx`; `no-default.tsx` → `react-no-default-export` and
    `NoDefault.ucf:<line>:<column>` (from `react.check` on the fixture); `vue-pick.ts` → `target-not-built`, `vue`.
  - dev scan: `createServer` on `react-basic` (native loader, `cacheDir` in a temp dir under `.tmp`, middleware mode,
    a capturing `customLogger`); after `depsOptimizer.scanProcessing`: no error logged and `metadata.discovered` has
    `react-dom/client` (without the scan plugin the scan logs "Failed to scan for dependencies" and skips pre-bundling).
- `packages/core/test/blocks/index.spec.ts`, `describe('buildTarget')`: `react/AllBlocks.ucf` react = `react.build`;
  `react/errors/NoDefault.ucf` throws `DiagnosticsError` with `react-no-default-export` at its line and column;
  `imports/VueOnly.ucf` react → `missing-target-block`; AllBlocks vue and svelte → `target-not-built`.
- `vueCompiler.spec.ts`, `build-context.spec.ts`, `style-parity.spec.ts`, `vue-reference.spec.ts` stay green.

## Docs

- `docs/milestones/m3-react-and-imports.md`: 3.6 text to what ships (`createUcfCache` / `UcfCache`, `buildTarget`
  throws `DiagnosticsError`, `load` reports splitter + target errors, style errors with their style module,
  `frameworks` not `targets`); 3.7 bullet "adds `@types/react-dom` (`react-dom` since 3.6)"; "Hands to later
  milestones" rows for `cache.ts` and `buildTarget`; `- Status: done` last line of 3.6.
- `docs/milestones/m5-library-build.md:67`: "throws `DiagnosticsError` on the file's errors".
- `docs/milestones/README.md`: infra row (section 6).
- `publicdocs/07-errors.md`: the `target-not-built` row now covers the build too.
- `docs/spec.md`, `docs/architecture.md`, `docs/plan.md`: none.

## Fuzzing

None: no cheap oracle here; 3.13 fuzzes the transform output.

## Out of scope

- The post attribute rewrite (3.7), HMR (3.15), SSR render and browser tests (3.7, 3.9). Vue / Svelte load (M4 / M6).
- Reading `with` attributes during the dependency scan: the scanner never passes them.

## Decisions

Orchestrator's answers to the plan:

- `buildTarget` keeps the `VirtualFile` return and throws `DiagnosticsError`: the hand-off fixes that shape.
- `buildTarget` reports splitter errors + the chosen target's check; style errors stay with their style module (as
  plugin-vue reports only the blocks it compiles; one problem, one error).
- `react-dom` becomes a root devDependency in 3.6, not 3.7: test tools are root devDependencies, the fixture needs it now.
- The vue-pick error entry writes `?framework=vue`: the exact form 3.7's rewrite emits; 3.7 covers the attribute form.
- `createUcfCache` returns `{splitUcf, loadUcf}`; the hand-off row names the factory.
- Also: the `missing-target-block` message lives in core, shared with language-tools; in scan mode non-react picks and
  errors are external, with no error; fixture configs load from source through the native loader.

## Done when

- `react-basic` builds with real plugin-react; `react-target.spec.ts` and the `buildTarget` tests pass;
  `pnpm devx check` passes.
- Milestone 3.6 ends with `- Status: done`; later steps / milestones match the shipped names.
- This todo moved to `docs/done/`, matching what shipped.
- The review ran and its findings are fixed.
- The simplify-comments pass ran on every touched source file, committed on its own.
