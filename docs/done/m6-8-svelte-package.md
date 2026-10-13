---
type: feature
spec: full-plan
status: done
created: 2026-10-13
milestone: 6
step: 6.8
---

# Milestone 6.8: the Svelte package

## Problem

`buildLibrary()` writes `dist/react` and `dist/vue` only. `libraryTargets` (`packages/vite/src/library/targets.ts`) has
no `svelte` row and is `satisfies Partial<Record<Target, LibraryTarget>>`; `build.ts:192` skips frameworks without a
row and `build.ts:200` throws "has no library build". The `<svelte>` blocks of the fixture library never ship.

Checked on this host with throwaway scripts outside the repo:

- One real Vite build works for Svelte: plugin-svelte + `multifront({framework: 'svelte'})` + `preserveModules` +
  `libraryCss` over the fixture gives one compiled chunk per component (facade `/abs/Card.ucf.svelte.svelte`, named
  `Card.js` by `outputName`), `index.js` importing `./Card.js`, `utils/cx.js`, `_virtual/Card.module-0.js`,
  `_virtual/multifront/scope-attrs.js`, the right `Card.css` … `styles.css`, and a `.js.map` asset per chunk in the
  bundle at `generateBundle`. Peers stay external (`svelte/internal/client`, …).
- svelte2tsx 0.7.61 `emitDts` over a staged folder under `node_modules/.cache/` with a `tsconfig.json` whose `files`
  lists `.svelte` files gives `Card.svelte.d.ts`, `index.d.ts` (`export {default as Card} from './Card.svelte'`) and
  `utils/cx.d.ts`. But:
  - a type-only module gets no `.d.ts`: TypeScript emits nothing for an imported-only file under `node_modules`
    (`isExternalLibraryImport: contains(parts, "node_modules")` in its resolver), as in 6.6;
  - it keeps `import './Card.css';` in `Card.svelte.d.ts`. TypeScript 6 turns `noUncheckedSideEffectImports` on by
    default, so that line fails a check with `skipLibCheck: false`;
  - `let __ucfRest = $props();` with no type (the line core's forwarding adds to a component with no `$props()`,
    like Counter) gives a broken `.d.ts`: `Component<$$ComponentProps, …>` with `$$ComponentProps` never declared, JS
    or TS. `let {...__ucfRest} = $props();` gives `Component<Record<string, any>, …>`.
- `tsc --listFilesOnly` reports syntax errors only, never type errors.
- publint 0.3.24 `--strict` passes a svelte-package-shaped folder with `exports` entries `{types, svelte}` (no
  `default`) and a top-level `"svelte": "./index.js"`.
- attw `--profile esm-only` on such a tarball fails node16-from-ESM on `index.d.ts`'s `./Card.svelte` (node16 looks
  for `Card.d.svelte.ts`); bundler resolution passes. Every svelte-package output does the same.

## Plan

### 1. Core: library mode for the Svelte build (`packages/core`)

- `types.ts`: `LibraryMode {src: string}` (exported). `BuildContextOptions.library?: LibraryMode` and
  `BuildContext.library?: LibraryMode`; `createBuildContext` copies it. `src` is the folder the package mirrors. Only
  the svelte build reads it.
- `react/scopeHelper.ts`: `LIBRARY_SCOPE_HELPER = '_ucf/scopeAttrs.js'` (exported), the helper's path in a Svelte
  package.
- `svelte/library.ts` (new), used by `build()` in `blocks/svelte.ts` when `ctx.library` is set. In place of the app
  import lines:
  - `import "./Card.css";` when `ctx.styles.length > 0`;
  - `import {__ucfScopeAttrs} from "../_ucf/scopeAttrs.js";` (posix path from the file's folder to
    `<src>/_ucf/scopeAttrs.js`, `./…` when it does not start with `.`);
  - `const __ucfStyle = {"card": "…"};` per class map, inlined from `StyleModule.classes`.
  - A `<script>` library mode has to add is written `<script lang="ts">`: svelte2tsx types a script-less JS
    component with a `SvelteComponent` it never imports, so its `.d.ts` would not check.
  - Every relative `.ucf` specifier of the block becomes `.svelte` (the whole literal, `JSON.stringify`, MagicString
    over Svelte's AST): `ImportDeclaration`, `ExportNamedDeclaration` / `ExportAllDeclaration` sources in the module
    and instance scripts, and an `ImportExpression` with a string literal anywhere, markup included.
- Related fix, own commit: `svelte/forward.ts` writes `let {...__ucfRest} = $props();` instead of
  `let __ucfRest = $props();`, in apps and the library (spec 3.5.1's shape). Updates the snapshots under
  `core/test/__snapshots__/svelte/roots/` and `FORWARD_LINE` in `core/test/blocks/svelte.spec.ts`.

### 2. The svelte row and one build path (`packages/vite`)

- `types.ts`, `LibraryTarget`:
  - `conditions?: string[]`: export conditions naming each file, after `types`; default `['default']`. A condition
    other than `default` is also a top-level field naming the index (svelte-package's `"svelte"`).
  - `sourceExt?: '.svelte'`: components ship uncompiled as `Card<sourceExt>`; the build still compiles them for its
    checks, CSS and module graph. No `emit(job)` hook.
  - `LibraryPackageJob` gains `componentExt` (`.js` or `.svelte`) and `conditions`. `LibraryComponent` (a `.ucf` file,
    split once) and `Lang` move to `types.ts`, shared by `build.ts`, `source.ts`, `dts.ts` and `specifiers.ts`.
- `library/targets.ts`: svelte row (`plugin` = `(await import('@sveltejs/vite-plugin-svelte')).svelte()`,
  `peers: {svelte: '^5.0.0'}`, `conditions: ['svelte']`, `sourceExt: '.svelte'`, `emitTypes: emitSvelteTypes`), then
  `satisfies Record<Target, LibraryTarget>`.
- `library/build.ts`: default `frameworks` = every target some file has a block for; `nothing to build` reads "no .ucf
  file in <src> has a framework block". The "has no library build" branch goes; an unknown name (JS config) fails with
  `buildLibrary: unknown framework 'angular'; use vue, react, svelte` (core's `isTarget`). Adds `librarySource(job)`
  when the row has `sourceExt`. Jobs carry `componentExt` and `conditions`.
- `library/source.ts` (new), `librarySource(job)`, `enforce: 'post'` after `libraryCss` (which reads the component
  chunks' imports to order `styles.css`):
  - `renderChunk`: in non-component chunks (index, plain modules) a relative specifier pointing at a component chunk
    (`./Card.js`, `import('../Card.js')` too) becomes `./Card.svelte` (Vite's `parseAst` + MagicString, with a map).
  - `generateBundle`: deletes every chunk whose modules are all virtual (`\0`) or `.ucf` ids, and its `<file>.map`.
    Emits `Card.svelte` per component from `buildTarget(split, ctx, target)` with
    `createBuildContext(split, {root, compiler: loadVueCompiler(root), production: true, library: {src}})`, one
    function shared with the types stage. A runtime import in that source that is neither relative nor a peer (an
    alias into `src`, which the Vite build resolved but a consumer cannot) is a build error (`isPeer()` in `names.ts`,
    shared with the peer-only guard). Emits
    `_ucf/scopeAttrs.js` (`scopeHelperCode(false)`) when the bundle held `\0virtual:multifront/scope-attrs`; a file
    already at that name is a build error. A plain `.svelte` file or a `.svelte.js` / `.svelte.ts` module in the graph
    is a build error.
- `library/packageJson.ts`: entries `{types?, …conditions → file}`; types file `Card.d.ts` for `.js`,
  `Card.svelte.d.ts` for `.svelte`. A top-level `[condition]: './index.js'` per non-`default` condition, after
  `types`. React and Vue output unchanged.

### 3. Svelte types (`library/dts.ts`, `emitSvelteTypes`)

- Needs `typescript` (listing run) and `@multifront/language-tools`, from the library root; svelte2tsx loads through
  `createRequire(<language-tools path>)` (its pinned dependency). Missing one: `the svelte types need <peer>; install
  it, or set dts: false`.
- Stage with `stageSources`: each `.ucf` as `Card.svelte` holding the library-mode code (the shipped text), `.ucf`
  specifiers in plain files → `.svelte`.
- Listing run: beside each staged component a `Card.svelte.ts` (TypeScript even for a JS component: svelte2tsx writes
  type declarations into its script) with `svelte2tsx(code, {filename, isTsFile, mode: 'dts', noSvelteComponentTyped: true}).code`, `isTsFile` by
  svelte2tsx's own `lang="ts"` test; the existing `reachedRoots` (`tsc --listFilesOnly`), shims among the roots; copies
  deleted, `Card.svelte.ts` mapped back to `Card.svelte`. The staging and cleanup moved into `withStage()`, shared with
  React and Vue; the specifier rewrite moved to `library/specifiers.ts`, shared with `librarySource()`.
- Writes the tsconfig with every reached file as a root, runs
  `emitDts({libRoot: stage, declarationDir: outDir, svelteShimsPath, tsconfig})` (never fails on a type error, like
  svelte-package), removes each side-effect `.css` import from the written `.svelte.d.ts` files, deletes the stage in
  `finally`.

## Decisions

- One Vite build for all rows (`sourceExt` + `librarySource`), no `emit(job)` hook: the milestone's own risk line
  allows it and the experiment shows it works (orchestrator, rule 1).
- A plain `.svelte` / `.svelte.ts` file in `src` is a build error now, plus a guidelines todo to ship them as source
  (orchestrator, rule 3).
- The exit test's attw run on the Svelte tarball ignores node16's internal resolution error, the text says why
  (orchestrator, rule 4).
- `library: {src}` instead of `library: boolean`: the helper path needs the file's depth.
- Svelte exports are `{types, svelte}`, no `default`: the svelte-package layout, publint-checked.
- `let {...__ucfRest} = $props()` in apps too: related fix (svelte2tsx), matches spec 3.5.1, own commit.
- No fuzz addition: the core table covers every Svelte fixture shape (orchestrator, rule 3).

## Tests

All run on this host and in CI's `check` and floor jobs inside `pnpm devx test`. No new infra: real `vite.build()`,
tsc, publint, `pnpm pack` already run there (6.6, 6.7).

- Build area, `packages/e2e/build/svelte-library.spec.ts` (new): builds `{frameworks: ['svelte']}`, packs.
  - Exact file list: each component's `.svelte`, `.svelte.d.ts`, `.css` (nested `forms/Field.*`), `index.js`,
    `index.d.ts`, `utils/cx.js`, `utils/cx.d.ts`, `utils/cx.js.map`, `_ucf/scopeAttrs.js`, `styles.css`, `package.json`,
    `README.md`, `LICENSE`; `skipped` = `['Badge.ucf', 'VueOnly.ucf']`.
  - Every `.svelte` compiles with the real `svelte/compiler` (client, server), no warning; no shipped file holds
    `.ucf`, `virtual:`, `\0` or `?ucf`.
  - Every relative specifier points at a file of the package (scripts and markup `import()` of each `.svelte` through
    Svelte's parser, `.js`, `.d.ts` with `./x.js` → `x.d.ts` and `./Card.svelte` → `Card.svelte.d.ts`).
  - `Card.svelte`'s inlined `__ucfStyle` values are class selectors of `Card.css`.
  - `Card.css` has `[data-v-<scopeId>]`, `Card.svelte` stamps the same; `styles.css` joins the files dependency-first.
  - Real `tsc` over `fixtures/library-checks/svelte.ts` (`tsconfig.svelte.json`, shims copied beside it, lib check on):
    right props pass, `// @ts-expect-error` on wrong ones. Fails without the forward fix or the CSS-import strip.
  - A type-only `src/types.ts` used in Card's `<svelte>` props gets `types.d.ts` (the listing run).
  - The whole `package.json`; the tarball passes `publint --strict`.
  - A plain `src/Child.svelte`, or a `src/count.svelte.ts` runes module, imported by Card fails with the plain-Svelte
    error.
  - An alias into `src` in Card's `<svelte>` block fails with the bare-import error.
  - `src/utils/cards.ts`'s `import('../Card.ucf')` ships as `import("../Card.svelte")`.
  - A `src/_ucf/scopeAttrs.ts` fails: it would be written where the scope helper ships.
- Core, `packages/core/test/svelte/library.spec.ts` (new): library mode over every
  `components/svelte/{shapes,roots,imports,library}` fixture, the library fixture's `src` and a new
  `components/svelte/library/DynamicImport.ucf` (markup `import()` of a
  `.ucf`): compiles with the real Svelte compiler, no virtual or `?ucf` id, `.ucf` → `.svelte`, the CSS import exactly
  when the file has styles, class map consts equal `ctx.modules`, the helper path relative to `src`. Also in the
  `windows` CI job (its paths go through `path.relative`).
- Updated (svelte is now a default framework): `build/library.spec.ts`, `build/library-types.spec.ts` (missing-peer
  rows for svelte), `consumer/pack.spec.ts`.

## Docs

- `docs/milestones/m6-library-build.md`: the "One target, one row" decision, the 6.8 Build text (one build,
  `sourceExt`, `library: {src}`, `{types, svelte}` exports, `_ucf/scopeAttrs.js`), the "Svelte's `emit(job)` hook"
  risk bullet settled, the exit test's attw flag for Svelte, `- Status: done`.
- `docs/architecture.md`, library build bullet: the Svelte swap, `_ucf/scopeAttrs.js`, emitDts types, the `svelte`
  condition.
- `docs/plan.md`: the Svelte types need `typescript` and `@multifront/language-tools` (its svelte2tsx).

## Fuzzing

None. A cheap oracle exists (library mode against app mode in the svelte scope fuzz), but library mode only touches
the import header and literal specifiers, and the core table runs every Svelte fixture shape.

## Out of scope

- A user-written JS script that is not in runes mode still gets svelte2tsx's `.d.ts` with an unimported
  `SvelteComponent`, as with svelte-package (noted in the milestone's risks).
- Shipping plain `.svelte` / `.svelte.ts` files of `src` (guidelines todo).
- `mf-build` (6.9), the consumer apps (6.10 to 6.13).
- Failing the build on a Svelte type error (emitDts does not, nor does svelte-package).

## Done when

- `dist/svelte/` follows the svelte-package layout, every test above passes, `pnpm devx check` is green.
- Milestone, architecture and plan docs updated; the todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
