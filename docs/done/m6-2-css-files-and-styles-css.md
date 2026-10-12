---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.2
---

# Milestone 6.2: CSS as real files, plus `styles.css`

## Problem

6.1's library build writes every component's CSS into one `styles.css` (Vite lib mode, `cssCodeSplit: false`), and no
JS file imports any CSS. A consumer importing `Card` gets no styles unless they import `styles.css` themselves, and all
styles when they do. Spec 8 wants CSS as real files: each component JS imports its own `Card.css`, a combined
`styles.css` beside them, nothing injected at runtime.

A dry run (Vite 8.2.2, the fixture library, `cssCodeSplit: true`, a spy plugin) showed:

- Vite's per-chunk CSS naming does not hold up under `preserveModules`: every style module is its own pure-CSS chunk,
  so Vite writes one CSS file per `<style>` block, named after that chunk (`Card.ucf_ucf_type_style_index_0_lang.css`,
  `..._index_1_lang.css` for React's `Card`). In Vue the class-map CSS sits on the `_virtual/Card.module-0.js` chunk,
  not on `Card.js`. Asset names alone cannot fix it: two blocks would both be `Card.css` and Rolldown renames the second.
  So the step's fallback applies: our plugin collects each component's compiled CSS and writes one file per component.
- In the component chunk's (`Card.js`) `renderChunk`, its `viteMetadata.importedCss` is still empty: Vite fills it in
  `generateBundle`, when it removes the pure-CSS chunks. A pure-CSS chunk's own `importedCss` is set in its `renderChunk`.
- Vite replaces an import of a pure-CSS chunk with a same-length `/* empty css */` comment (source maps stay right), and
  in ES lib output never injects a `<style>` tag.
- With `cssCodeSplit: true`, `build.lib.cssFileName` is never read (only Vite's single CSS file uses it).
- Vite's CSS files do not end with a newline: joined as is, they give `}.card`.

## Decisions

- Plain `.css` files imported from code (`import './theme.css'` in a `.ts` module or a `<react>` block) are a build
  error naming the file and its importer (orchestrator, rule 3: a clear error beats CSS silently dropped; supporting
  them is work 6.2 does not ask for). No todo for supporting them.
- The fallback path (our plugin groups Vite's per-block CSS by `.ucf` file), the `styles.ucf` guard and `magic-string`
  1.3.1 in `@multifront/vite` dependencies: approved as planned.

## Plan

### `packages/vite/src/library/css.ts`: `libraryCss(job)`, a plugin only library builds add

Added to `buildOne()`'s `plugins` (`packages/vite/src/library/build.ts:155`) after `libraryPlugin(job)`.
`enforce: 'post'`, so its hooks run after `vite:css-post`.

- `config()` returns `{build: {cssCodeSplit: true}}`: the plugin needs it, and a plugin's `config` result wins over the
  user's `vite` option. `cssFileName: 'styles'` and its "6.2 replaces" comment go from `build.ts:165`.
- **Which components have CSS** (`renderStart`): over `this.getModuleIds()`, an id whose path is a `.ucf` file, whose
  query has `type=style`, and for which `isCSSRequest(id)` (from `vite`) is true marks its `.ucf` file as styled. That
  covers `?ucf&type=style&index=0&lang.css` and plugin-vue's `lang.module.css` / `lang.scss`, not our class map
  `…&module&lang.js`.
- **Prepend the import** (`renderChunk`, after `vite:css-post` through `enforce: 'post'`): a component chunk (facade id with no query,
  `fileOf(facade)` a styled `.ucf` file) gets `import "./Card.css";\n` at offset 0 with MagicString, returned as
  `{code, map: s.generateMap({hires: 'boundary'})}`. The specifier is the CSS file's basename: it sits in the chunk's
  folder (`forms/Field.js` → `./Field.css`). 6.3 later puts `"use client"` above it.
- **Record CSS owners** (same `renderChunk`): a chunk whose facade is a `.ucf` style id maps every file in its
  `viteMetadata.importedCss` to `{file: <the .ucf file>, index: <query index>}`. Covers React's pure-CSS chunks and
  Vue's `Card.module-0`. A chunk with CSS whose facade is not a `.ucf` style id is the plain-CSS error:
  `buildLibrary: src/theme.css is imported by src/utils/theme.ts: a library package ships CSS from .ucf <style> blocks
  only`.
- **Write the files** (`generateBundle`):
  - per styled `.ucf` file, its CSS files in `index` order, each trimmed plus one `\n`, emitted as
    `this.emitFile({type: 'asset', fileName: outputName(file, src) + '.css', source})`. A styled file with no CSS
    asset gets an empty file, so its import always resolves.
  - Vite's per-block CSS assets are deleted from the bundle.
  - each component chunk's `importedCss` becomes its new file, the others' is cleared (a user's `build.manifest`
    stays true).
  - `styles.css`: every component CSS file, dependencies first. Component chunks in sorted `fileName` order, each
    walked depth first over `chunk.imports` (only entries in the bundle, so peers like `vue` and `react/jsx-runtime`
    are skipped) and added after its imports; a visited set stops cycles. Rolldown's own order only, so the same every
    run. React: Badge, Button, Icon, Card, Counter, Panel, Tooltip, forms/Field. Vue: the same with VueOnly before
    forms/Field.
- **Guard**: a component written as `styles.css` (`src/styles.ucf`) is a build error:
  `buildLibrary: src/styles.ucf would be written as styles.css, the name of the combined CSS file`. Without it the
  second `emitFile` overwrites the first.

### Dependency

- `magic-string` `1.3.1` exact in `@multifront/vite` `dependencies`, core's pin (already in the lockfile):
  `pnpm add --filter @multifront/vite magic-string@1.3.1`.

## Tests

Build area, new `packages/e2e/build/library-css.spec.ts`. Runs inside `pnpm devx test`: this host, CI's `check` job,
the react / vue / svelte floor jobs. Needs only real `vite.build()` through 6.1's `buildFixtureLibrary()` /
`withEditedLibrary()`: no new infra. One `beforeAll` builds the fixture into its own temp `outDir`; every other case
uses its own copy or `outDir`.

1. One CSS file per component: the `.css` files per target are exactly `Name.css` for each component with styles plus
   `styles.css`. React: Badge, Button, Card, Counter, Icon, Panel, Tooltip, forms/Field; Vue: the same plus VueOnly.
   No `_virtual/*.css`, no name with `.ucf`.
2. Each component imports its own file: `react/Card.js` and `vue/Card.js` start with `import "./Card.css"` (first
   specifier, oxc-parser via `specifiersOf`); `react/forms/Field.js` imports `./Field.css`.
3. Nothing else imports CSS: `index.js`, `utils/cx.js`, `hooks/useToggle.js` and every `_virtual/*` file import no
   `.css` specifier. On a copy that adds `src/Plain.ucf` (React and Vue blocks, no `<style>`), `Plain.js` imports no
   CSS in either target and no `Plain.css` is written.
4. Scoped and compiled: `react/Card.css` and `vue/Card.css` hold `[data-v-<id>]` with `<id>` from core's
   `scopeId('src/Card.ucf', source, true)`, the compiled SCSS (the `:hover` rule carries the attribute, no `&` left),
   and the module rules (`--card-padding: 16px`) before the scoped ones.
5. `styles.css` equals the component files joined in the fixed orders above (Icon before Card, Counter before Panel).
   A second build into a fresh `outDir` gives every `.css` file byte for byte the same.
6. No runtime injection: no `.js` file in either target contains `document.createElement('style')`, `__vite_style__`
   or `__vite__updateStyle`.
7. Guard: a copy with `src/styles.ucf` rejects with the `would be written as styles.css` message.
8. Plain CSS: a copy where `utils/cx.ts` imports `./cx.css` rejects naming `src/utils/cx.css` and
   `src/utils/cx.ts`.
9. Source map: in `react/Card.js`, the `return` of the JSX maps to the `return (` line of the `<react>` block. Without
   the map `renderChunk` returns it reads one line too far (checked).

6.1's `library.spec.ts` source map case ("maps a line of the JSX in react/Card.js back into Card.ucf") turned out
not to catch a dropped map: several output lines of the `<h2>` call map to one source line. Hence case 9. The other
`library.spec.ts` cases list only `.js` files and stay as they are.

## Docs

- `docs/architecture.md`, "Build", the library-build bullet: one sentence more: each component's CSS is one real
  file (`Card.css`) its JS imports, a combined `styles.css` beside them in dependency order, nothing injected at
  runtime. No graphic changes.
- `docs/spec.md` 8 and `docs/plan.md` 6 already say this: no change. `publicdocs/`: none (milestone docs writer).
- Milestone doc, step 6.2: Build lines changed to what shipped (the fallback, `cssCodeSplit` set by the plugin,
  `cssFileName` gone, the two new errors), `- Status: done`. "Hands to later milestones" stays (`css.ts`).

## Results

- Shipped the plan, with these changes:
  - `fileOf()` and `shownFile()` moved from `build.ts` to `names.ts`, as `css.ts` needs them and `build.ts` imports
    `css.ts`.
  - Each block's CSS is trimmed at both ends: Vue's class-map CSS starts with a blank line.
  - Test case 9 added (above).
  - `pnpm add` deduped vitest's transitive `magic-string` 1.2.3 to the 1.3.1 already in the lockfile (pnpm's
    `resolutionMode: highest`); no new package downloaded.
- `library-css.spec.ts`: 9 cases, all green; without the plugin, the 6 cases that check what it adds fail.
  `library.spec.ts` still passes; `pnpm devx check` passes.

## Fuzzing

Not a candidate: the step rewrites no source text and keeps no offsets beyond a fixed one-line prepend. Determinism,
the one cheap oracle, is test 5.

## Out of scope

- `"use client"` (6.3), types (6.6), `package.json` with `sideEffects` (6.7), the Svelte row's CSS (6.8 reuses this).
- Minified CSS, CSS source maps.
- Shipping plain `.css` files imported from code (an error here).

## Done when

- Every component with styles ships `Name.css` beside `Name.js`, its JS imports it on the first line; `styles.css`
  holds all of them in dependency order, the same every run; no JS injects CSS.
- `packages/e2e/build/library-css.spec.ts` passes, and `library.spec.ts` still does; `pnpm devx check` passes.
- `docs/architecture.md` and the milestone doc updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
