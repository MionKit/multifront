---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.1
---

# Milestone 6.1: `buildLibrary()`: one JS file per component, per target

## Problem

Nothing turns a folder of `.ucf` files into per-framework packages yet. This step adds the first part: `buildLibrary()`
runs one real `vite build` per framework and writes one JS file per component and one per plain module, to
`dist/react/` and `dist/vue/`. CSS files (6.2), `"use client"` (6.3), types (6.6), `package.json` (6.7) and Svelte (6.8)
come later, on top of this step's table, entries and naming.

A dry run (Vite 8.2.2, `preserveModules`, a small copy of the planned fixture) showed:

- Rolldown's own names leak `.ucf`: `Card.ucf.js`, `Icon.ucf.react.js`, `Card.ucf_ucf_type_style_index_0_module_lang.js`
  (our class map), `Card.ucf_vue_type_script_setup_true_lang.js` and `..._lang.module.js` (plugin-vue's sub-modules),
  `index.ts.js`, `_virtual/_virtual_multifront/scope-attrs.js`. A naming function is needed.
- `build.lib` with no `cssFileName` fails ("Name in package.json is required"): set `cssFileName: 'styles'`.
- `./utils/cx.js` resolves to `cx.ts` from the react id and from plugin-vue's `lang.ts` script id.
- CSS-only style modules give empty chunks that Rolldown drops: no JS file from them.
- Vite reads `isProduction` from `process.env.NODE_ENV`; Vitest sets `test`, which would give dev scope ids and dev
  JSX. A library is always a production build.

## Decisions

- Our class maps and plugin-vue's `?vue&type=…` sub-modules go under `_virtual/` (orchestrator, rule 1: milestone 6.1
  "Virtual modules go under `_virtual/`"; they name no file on disk). Recorded in the step text.
- Three errors beyond the step's Build line stay ("outside src", "no file has that framework's block", a missing
  `index` path), each with its own test case (orchestrator, rule 3 for the errors, rule 1 "New/changed behaviour has
  Vitest coverage" for the tests).

## Plan

### Types (`packages/vite/src/types.ts`)

Exactly the milestone shapes:

```ts
interface LibraryOptions {
  root?: string;           // library folder, default process.cwd()
  src?: string;            // default 'src'
  index?: string | false;  // default 'src/index.ts' when it exists
  outDir?: string;         // default 'dist'; each target writes <outDir>/<target>/
  frameworks?: Target[];   // default: every framework with a row and at least one block
  packages?: Partial<Record<Target, {name?: string; peers?: Record<string, string>}>>;
  vite?: InlineConfig;     // merged into every target's build
  dts?: boolean;           // default true, used from 6.6
}
interface LibraryResult {target: Target; outDir: string; packageName: string; files: string[]; skipped: string[]}
```

### Target table (`packages/vite/src/library/targets.ts`)

```ts
export interface LibraryTarget {
  plugin(): Promise<PluginOption>;    // the framework's Vite plugin, loaded only when that target builds
  peers: Record<string, string>;      // default peer ranges; also the externals
}
export const libraryTargets = {
  react: {plugin: …'@vitejs/plugin-react', peers: {react: '^19.0.0', 'react-dom': '^19.0.0'}},
  vue: {plugin: …'@vitejs/plugin-vue', peers: {vue: '^3.5.0'}},
} satisfies Partial<Record<Target, LibraryTarget>>;
```

- The plugins are imported dynamically: they are optional peers, so a static import would break `@multifront/vite` for
  a user without them.
- No `conditions`, `emit` or `emitTypes` yet: 6.6, 6.7, 6.8 add them with their first user.

### `buildLibrary` and `defineLibrary` (`packages/vite/src/library/build.ts`)

Both exported from `packages/vite/src/index.ts`, plus `export type {LibraryOptions, LibraryResult}`. `multifront()` moves
from `index.ts` to `plugin.ts` (`index.ts` only re-exports): `build.ts` calls it, and oxlint's `import/no-cycle`
forbids `build.ts` importing `index.ts`.

- `defineLibrary(options)` returns its argument, typed.
- Options: `root` resolved from cwd; `src`, `outDir`, `index` against root. `index` defaults to `src/index.ts` only when
  it exists; a given path that does not exist → error.
- Scan: every `.ucf` under `src`, recursive, split once with `splitBlocks(source, filename)`. Per target, files with
  `split.targets[target]` are entries; the rest go in `skipped`, relative to `src`, posix (`VueOnly.ucf`).
- Frameworks: default is `TARGETS` (core's order: vue, react, svelte) filtered to those with a row and at least one
  block. An explicit framework with no row → error naming it. An explicit one no file has a block for → error naming
  the target and `src`.
- `packageName`: `packages[target].name`, else `<library package.json name>-<target>`; neither → error.
- Peers: `{...row.peers, ...packages[target]?.peers}`; their keys are the externals.
- One real `vite build` per target, always production: `process.env.NODE_ENV = 'production'` for the duration,
  restored after. Config, merged with `options.vite` through `mergeConfig`:
  - `configFile: false`, `root`, `mode: 'production'`, `publicDir: false` (a library's `public/` is not copied),
    `logLevel: 'warn'`.
  - `plugins: [await row.plugin(), multifront({framework: target, frameworks: [target]}), libraryPlugin(…)]`.
  - `build`: `outDir: <outDir>/<target>`, `emptyOutDir: true`, `minify: false`, `sourcemap: true`,
    `lib: {entry, formats: ['es'], cssFileName: 'styles'}`, `rolldownOptions.output: {preserveModules: true,
    preserveModulesRoot: src, entryFileNames, chunkFileNames}` from the naming function.
- `files`: every file written under the target's outDir, relative, posix, sorted, read from disk after the build.

### Naming (`packages/vite/src/library/names.ts`)

`outputName(id, src)` on `chunk.facadeModuleId ?? chunk.moduleIds[0]`, plus `.js`:

| Id | Name |
| --- | --- |
| `X.ucf`, `X.ucf.react.tsx`, `X.ucf.svelte.svelte` | relative to `src`, no `.ucf` or target suffix: `Card`, `forms/Field` |
| plain module `.ts` / `.tsx` / `.js` / `.mts` … | relative path minus its extension: `utils/cx`, `index` |
| a `.ucf` path with a query (our class map, plugin-vue's sub-modules) | `_virtual/<rel>.<type>[-<index>]`, a class map (ours flags `module`, plugin-vue's `lang.module.css`) as `module`: `_virtual/Card.module-0`, `_virtual/Card.script`; a CSS-only style module is `style-0`, a chunk Rolldown never writes |
| `\0` ids | `_virtual/` + the id without `\0` and a leading `virtual:`, `:` → `/`, unsafe characters → `_`: `_virtual/multifront/scope-attrs` |
| a real file outside `src` | build error naming the file: its output path would leave the target folder |

### Peer-only guard (`libraryPlugin`, in `build.ts`)

A pre `resolveId` filtered to bare specifiers (not `.`, `/`, `\0`):

- A peer or a peer's subpath (`react/jsx-runtime`) → `{id, external: true}`.
- Else `this.resolve(…, {skipSelf: true})`: a `\0` result (our `virtual:multifront/scope-attrs`) or a file inside `src`
  (an alias) passes. Anything else (unresolved, `node_modules`, outside `src`) → `this.error`: `"left-pad" is imported
  by src/utils/cx.ts, but it is not a peer dependency of @mf-fixture/ui-vue: a library package has peer dependencies
  only. Add it to packages.vue.peers to keep it external.` A target id importer is named by its `.ucf` file.

### Fixture: `packages/e2e/fixtures/library/`

A real library, not a workspace package (`pnpm-workspace.yaml` matches only `packages/*`); vue, react and the plugins
resolve up the tree.

- `package.json` (`@mf-fixture/ui`, `version`, `description`, `license`, `author`, `keywords`, `type: module`),
  `README.md`, `LICENSE` (MIT).
- `src/index.ts`: re-exports, through `./X.ucf`, only components with every target's block: Card, Icon, Counter,
  Button, Panel, Tooltip, Field.
- Plain modules use `.js` specifiers, the form `tsc` and attw accept later (6.6, 6.7).
- `Card.ucf`: React, Vue, Svelte. `<style module>` with CSS variables (padding, color, border-radius, font-size on root
  and title, for the exit test), `<style scoped lang="scss">` using `&`, imports `./Icon.ucf` and `./utils/cx.js`.
  No hooks.
- `Icon.ucf`: React, Vue, Svelte, scoped style.
- `Counter.ucf`: React (`useState`, `onClick`, `useToggle` from `./hooks/useToggle.js`), Vue (`ref`), Svelte
  (`$state`).
- `Button.ucf`: React, Vue, Svelte; `<button>` root, module class through `cx`, `onClick` from props, no own
  `className` / `style` / `ref` handling.
- `Badge.ucf`: React and Vue; its React block reads `className` from props itself.
- `Panel.ucf`: React, Vue, Svelte, no hooks, renders `./Counter.ucf`.
- `Tooltip.ucf`: React block starts with `'use client'`, no hooks; Vue and Svelte blocks too, so `index.ts` exports it
  (6.12 imports it from the package root).
- `forms/Field.ucf`: React, Vue, Svelte, nested folder.
- `VueOnly.ucf`: only `<vue>`.
- `hooks/useToggle.ts`, `utils/cx.ts`: plain files.
- The Svelte blocks get compiled once by hand with plugin-svelte (not committed), so 6.8 inherits no broken block.

### Helpers

- `packages/e2e/fixtures/index.ts`: `LIBRARY_DIR`, `copyLibrary(): Promise<string>` (fresh copy under `TMP_DIR`),
  `removeLibrary(root)` (checks the folder sits in `TMP_DIR`).
- `packages/e2e/build/lib/library.ts`: `buildFixtureLibrary(root?, options?)` builds into a fresh
  `TMP_DIR/library-dist-*` outDir (Vite's logger silent, as the other build helpers), `withEditedLibrary(edits, run)`
  runs on an edited copy, `specifiersOf(file, code)` lists a module's specifiers through oxc-parser.

### Dependencies

- Root devDependency `source-map-js` 1.2.1, exact (already in the lockfile as transitive, older than 30 days), via
  `pnpm add -D -w`.
- Nothing new in `@multifront/vite`: plugin-react and plugin-vue are already optional peers and pinned devDependencies.

## Tests

Build area, `packages/e2e/build/library.spec.ts`. Runs inside `pnpm devx test`: this host, CI's `check` job and the
react / vue / svelte floor jobs. Needs only real `vite.build()`: no new infra. One `beforeAll` builds the fixture into
its own fresh temp outDir; every error case uses its own `copyLibrary()` copy and outDir, so files run in parallel.

1. Layout: results in order vue, react. `react/Card.js`, `react/forms/Field.js`, `vue/VueOnly.js` exist;
   `react/VueOnly.js` does not; React `skipped` is `['VueOnly.ucf']`, Vue `skipped` is `[]`. The `.js` files outside
   `_virtual/` equal the exact expected list per target (one per component with that block, `index.js`,
   `utils/cx.js`, React also `hooks/useToggle.js`).
2. No `.ucf`: in no file name; in no import / export-from / dynamic import specifier (oxc-parser). `react/Card.js`
   imports `./Icon.js`.
3. No cross-framework code: React output names no `vue` or `svelte` specifier (or subpath); Vue output no `react`,
   `react-dom` or `svelte`.
4. Peers external: `react/Counter.js` imports `react`; `react/Card.js` imports `react/jsx-runtime` (the production
   runtime, pinning the forced production build); no `.map` source under `node_modules`. A copy with
   `import leftPad from 'left-pad'` in `utils/cx.ts` rejects with the peer-only message naming `left-pad`.
5. Source map: real `source-map-js` `SourceMapConsumer` on `react/Card.js.map`; the generated `"h2"` JSX call maps to
   the fixture's `src/Card.ucf` (resolved against the map's folder), on the line of `<h2` in the `<react>` block.
6. `frameworks: ['svelte']` rejects naming `svelte` (no row; 6.8 turns this into a success).
7. A copy whose `Card.ucf` imports a real file outside `src` rejects with the "outside src" error naming that file.
8. A copy keeping only `VueOnly.ucf`, built with `frameworks: ['react']`, rejects naming `react` and `src`.
9. A copy with `index: 'src/missing.ts'` rejects naming that path.

## Docs

- `docs/architecture.md`, "Build": one bullet on the library build (one real `vite build` per framework with
  `framework` set and the row's plugin from `libraryTargets`; every `.ucf` file with that block an entry; modules stay
  files named without `.ucf`, sub-modules and virtual ones under `_virtual/`; only the row's peers external).
  No graphic change: `build.png` (one import, one target) stays true.
- `docs/plan.md`: none (6.9 adds the API and the command). `docs/spec.md`: none. `publicdocs/`: none (milestone docs
  writer).
- Milestone doc: `- Status: done` on 6.1; step text names `names.ts`, the `_virtual/<file>.<type>-<index>` rule and
  `cssFileName: 'styles'` (6.2 replaces the CSS layout).

## Results

- Shipped as planned. One naming change: a first build gave `_virtual/Card2.style-0.js`, as our CSS style module and
  class map both named `style-0`; a class map is now `module-<index>`, the same in React and Vue.
- `library.spec.ts`: 10 cases, all green. Dropping the forced `NODE_ENV` fails the production check
  (`react/jsx-runtime` missing).
- The fixture's Svelte blocks compile with plugin-svelte (checked by hand, not committed).

## Fuzzing

Not a candidate: the step rewrites no text and keeps no offsets. The naming function is a small total mapping over
module ids, checked on a fixed real fixture; no cheap oracle beyond test 2.

## Out of scope

- Per-component CSS and `styles.css` order (6.2); `"use client"` and Rolldown's directive warning (6.3); root props
  (6.4, 6.5); `.d.ts` (6.6, `dts` only typed here); `package.json` (6.7); the Svelte row (6.8); CLI and
  `multifront.config.ts` (6.9); consumers (6.10 to 6.13).

## Done when

- `buildLibrary({root, outDir})` writes `dist/react/` and `dist/vue/`, one JS file per component and per plain module,
  named without `.ucf`. Peers external; any other bare import fails with the peer-only error.
- `buildLibrary`, `defineLibrary`, `LibraryOptions`, `LibraryResult` exported from `@multifront/vite`;
  `libraryTargets` and `LibraryTarget` in `targets.ts`.
- `packages/e2e/build/library.spec.ts` passes, every case; `pnpm devx check` passes.
- `docs/architecture.md` and the milestone doc updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
