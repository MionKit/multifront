# Milestone 3: React target and imports

## Goal

An app imports a `.ucf` file and gets a working React component, with shared styles, in dev, build and SSR. This is the go / no-go milestone: it shows the whole idea works for one target before we build the others.

When it is done:

- The `<react>` block kind has its `check` and `build` halves. `build` makes the virtual module `Card.ucf.react.tsx` with the style imports, `$style`, and the scope transform.
- The scope transform (oxc-parser + MagicString) stamps `data-v-<id>=""` on every element and forwards the parent's scope attributes to the returned roots of the default export, so a parent's scoped style reaches a child root, as in Vue.
- `resolveTarget()` in core holds every target rule of spec 4.1 and 4.2. The Vite plugin and the TypeScript plugin both call it.
- The Vite plugin resolves the per-target ids of spec 4.3, serves the style CSS and class map modules, rewrites `with { framework }` into the id (spec 4.4), and does style-only and target-only HMR.
- A demo app proves it: Fast Refresh keeps state, a style edit only reloads CSS, a parent scoped style reaches a child root.
- We record a clear go or no-go. On no-go, React falls back to CSS modules only (see "Exit test").

- React's version is the user's: `react`, `react-dom` and `@vitejs/plugin-react` are optional peer ranges, and CI tests the bottom and the top of each range.

No runtime package: the forwarding helper is a virtual module served by the Vite plugin. We never compile React ourselves: we hand plain `.tsx` to the user's plugin-react.

## Needs from earlier milestones

From the current code (exists today):

- `@multifront/core`: `Target = 'vue' | 'react' | 'svelte'`, `TARGETS`, `isTarget(value)`.
- `@multifront/vite`: `multifront(options: MultifrontOptions): Plugin` with `MultifrontOptions = {frameworks?: Target[]; framework?: Target}`, `getVueCompiler(plugins, root)`, the plugin's `api.vueCompiler`, and the test `packages/vite/test/vueCompiler.spec.ts`.
- Commands: `pnpm devx test`, `pnpm devx check`, `pnpm devx typecheck`. Env registry `scripts/lib/env.mjs` (`REGISTRY`), `.env.sample`, `MULTIFRONT_CHROMIUM_PATH`.
- Root devDependencies `vite@8.2.2`, `playwright@1.63.0`, `vitest@5.0.0`.

From milestone 1 (splitter, block kinds, styles):

- `splitBlocks(source, filename)` in core, returning the blocks and the errors. One block is `Block = {type, attrs, content, start, end, contentStart, contentEnd}` (spec 3.2). Offsets are into the `.ucf` source.
- `Diagnostic = {code, message, line, column}`, with the code `react-no-default-export` already in its code list. M3 owns the check itself, in `react.check()`.
- The `BlockKind` contract and the registry in `packages/core/src/blocks/index.ts` (shared kinds first), with the `style` row complete and a `react` row to fill.
- `createBuildContext(split, {root, compiler, production})` and its `BuildContext`: `split`, `source`, `production`, `scopeId` (8 hex chars), `hasScoped`, `styles` (each with its module `id`), `modules` (class map per injection name, with its `classMapId`). Dev is `!ctx.production`.
- `compileStyles(blocks, {id, filename})`: CSS, map and CSS-module class map per `<style>`.
- `scopeId(relativePath, source, production)`.
- The style module id `/abs/Card.ucf?ucf&type=style&index=N&lang.css`, and the class map module (id and code). If M1 did not fix a class map id, M3 uses `/abs/Card.ucf?ucf&type=style&index=N&module&lang.js`.
- In dev, CSS-module class names depend on the file path and the class name only, not on the CSS text. Otherwise every module style edit also changes the class map (see risks).
- `packages/e2e`: a vitest project in the root `vitest.config.ts`, the folders `fixtures/components/`, `fixtures/apps/`, `build/`, and a way for a fixture app's `vite.config.ts` to load `@multifront/vite` from source. `@vue/compiler-sfc` resolvable from the fixture apps (React apps still compile styles with it, spec 3.1).

From milestone 2 (editor basics):

- `@multifront/language-tools/typescript-plugin`, which resolves `.ucf` imports from `.ts` / `.tsx` files to the `.ucf` file itself, whose service script is the React virtual script `Card.ucf.react.tsx` (spike 1: Volar's tsserver plugin has no extra service scripts). If it already calls a first `resolveTarget()`, step 3.3 replaces that function in place.
- The result of spike 1 (types by import attribute), recorded in `docs/plan.md`: the TypeScript plugin sees `with { framework }` per import, and TypeScript keeps one resolution per specifier and mode in a file.
- The editor test harness in `packages/e2e/editor/`: a real tsserver with our plugin loaded, which can tell where an import of `./Card.ucf` resolves (go to definition, or a TS error on the import).

## Steps

### 3.1 Spike: do import attributes survive each compiler?

Throwaway experiment (spike 3 of `docs/plan.md`), done before any other step. The post rewrite of spec 4.4 only works if the attribute is still on the import when post plugins see the code.

- Build:
  - A scratch Vite project **outside** the workspace (no lockfile change): `vite@8.2.2`, `@vitejs/plugin-react`, `@vitejs/plugin-vue@6.0.8`, `svelte` + `@sveltejs/vite-plugin-svelte` (newest versions past the 30 day release age).
  - A recording post plugin saves the code of each importer as post plugins receive it.
  - Importers, each with a static import, a re-export, `export * from` and a dynamic `import()` carrying `with { framework: 'react' }`:
    - `a.ts`, `b.tsx` (Oxc, through Vite's own transform and plugin-react);
    - `C.vue` with `<script setup lang="ts">`, and `D.vue` with a plain `<script>` (plugin-vue's script compile, then Oxc);
    - `E.svelte` with `<script lang="ts">` (the Svelte compiler).
  - Run each in dev (`transformRequest`), in a build and in SSR.
  - Three more checks the React path depends on:
    1. plugin-react applies Fast Refresh to an id ending in `?target=react&lang.tsx` (plugin-react 6.1 matches its `include` with the query allowed, so we expect yes).
    2. Vite's dependency scanner on a `.ucf` import with the attribute: what our `resolveId` receives (`options.scan`), and whether bare imports that appear only inside `<react>` blocks get optimized at startup.
    3. oxc-parser's node positions are UTF-16 offsets (a file with an emoji and accents before a JSX element).
- Deliverable: the verdict in `docs/plan.md`, "Prototype first", item 3: versions tested, which compilers keep `with`, and which of the changes below apply. The scratch project is thrown away. What changes if a check fails:
  - **Oxc drops it:** the rewrite moves from the post plugin to our pre `transform` on the raw `.ts` / `.tsx` / `.js` / `.jsx` source, before Oxc. Same core function (3.2), still before import analysis. Spec 4.4 and the "Build" bullet in `architecture.md` change.
  - **plugin-vue drops it:** milestone 4 runs the same rewrite in our pre `transform` on the `<script>` blocks of `.vue` importers, located with the borrowed compiler's `parse()`.
  - **Svelte drops it:** milestone 6 does the same on `.svelte` importers, located with `svelte/compiler` `parse`.
  - **A compiler cannot even parse `with`:** that importer type supports only the importer rule and the default. An attribute there is a build error. Spec 4.2 gets that note.
  - **Check 1 fails:** the React id changes so Vite parses it as TSX (verdict: `/abs/Card.ucf.react.tsx`, and the Svelte id with it: `/abs/Card.ucf.svelte.svelte`). Setting plugin-react's `include` does not help.
  - **Check 2 fails:** a load-only scan plugin in `optimizeDeps.rolldownOptions.plugins` serves the `<react>` block during the scan (3.6), and 3.14's cold start test guards it.
  - **Check 3 fails:** the scope transform converts positions once, in one helper, and 3.5 keeps a non-ASCII fixture.
- Test: a canary that keeps guarding the React path: `packages/e2e/build/attributes-survive.spec.ts` (area: build). Fixture `packages/e2e/fixtures/apps/attribute-canary/` (`plain.ts`, `component.tsx`, the four import forms, importing a plain `./target.js`). A real dev server with real plugin-react and the recording post plugin. It checks `with { framework: 'react' }` is still on all four imports in the dev and SSR transforms. It fails the day a Vite or plugin-react upgrade drops the attribute.
- Verdict: every compiler keeps the attribute; check 1 failed (new React and Svelte ids), check 2 needs the scan plugin, check 3 passed. Details in `docs/plan.md`, "Prototype first", item 3.
- Status: done

### 3.2 Import attribute rewrite in core

- Build: `packages/core/src/imports/rewrite.ts`, exported from core.

  ```ts
  rewriteImportAttributes(code: string, filename: string): {
    code: string; map: SourceMap | null; imports: UcfImport[]; errors: Diagnostic[];
  }
  interface UcfImport {kind: 'static' | 'reexport' | 'dynamic'; specifier: string; framework?: string; start: number; end: number}
  ```

  - Parses with oxc-parser (language from the path, else a `lang.<x>` query, else ts). Touches only imports whose specifier is a string literal ending in `.ucf`: `import`, `export ... from`, `export * from`, and `import()` with a literal first argument (a template literal without expressions counts, as in the TypeScript plugin). A file that does not parse comes back untouched: its own compiler reports the syntax error.
  - `start` / `end` of a `UcfImport` are the specifier literal's, quotes included. `framework` is the raw value, unchecked (`resolveTarget` judges it); the rewritten specifiers no longer end in `.ucf`, so a second run finds no import.
  - Moves `framework` into the specifier and removes it. Other keys in `with` stay. An empty `with {}` or `import()` options argument is removed whole.

    ```ts
    import Card from './Card.ucf' with { framework: 'react' };
    const C = await import('./Card.ucf', { with: { framework: 'svelte' } });
    // becomes
    import Card from './Card.ucf?framework=react';
    const C = await import('./Card.ucf?framework=svelte');
    ```

  - A value that is not a string literal is the error `framework-attribute-not-literal`, with its line and column. It joins `DiagnosticCode` here. A static `with {framework: x}` is already a syntax error, so it is the `import()` form: a non-literal value, or options (or their `with`) that are not an object literal or hold a spread or a computed key. That import is left as it is.
  - MagicString edits, so the map is exact; `null` when nothing changed.
  - Adds `magic-string` to core `dependencies`, exact-pinned (newest past the 30 day age); `oxc-parser` is already there (M1).
  - Fixtures: M1's `fixtures/components/Card.ucf` (all three target blocks, a `<style module>`) is the imported file. M2's shared imports set `packages/e2e/fixtures/apps/imports/` keeps its layout (each sub-project has its own `tsconfig.json`; the `vite.config.ts` files come with 3.7, `react-only/` with 3.3):
    - `src/` is the default-react project (the root `tsconfig.json`, `framework: 'react'`), already with `default.ts`, `App.tsx` (importer over the default) and `lazy.ts` (`framework: 'svelte'` over the default).
    - `no-default/` (no `framework`; M2's `bare.ts` is the case with no rule) gains `attribute.ts`, `attribute-over-importer.tsx` (`framework: 'vue'` in a `.tsx`), `reexport.ts`, `export-all.ts`, `dynamic.ts`, `importer.tsx`, `jsx-importer.jsx` (not `importer.jsx`: TypeScript leaves out a `.jsx` beside a `.tsx` of the same name), `non-literal.ts` (`import()` with `{with: {framework}}`), `unknown.ts` (`framework: 'angular'`), `strings-and-comments.ts` (`.ucf` imports inside comments, a string and a template literal).
    - Every import gets a row in M2's `expected.ts` (`{file, specifier, line, options, expect, rule?}`, `rule` on every target row), the one table the build and the editor both satisfy. An error row can also expect `framework-attribute-not-literal`.
    - `packages/e2e/fixtures/apps/rewrite-edges/`: the forms no build may see (unknown attribute keys), as `.js` so the formatter keeps them as written: `other-keys.js`, `dynamic-options.js`, `comments.js`, `not-literal-options.js`, `syntax-error.mjs`; 3.8 adds `nested-dynamic.js` (an `import()` inside another's options).
  - The test helper `packages/core/test/imports/readImports.ts` reads every fixture's imports through `rewriteImportAttributes`.
- Deliverable: the one function every host uses to read and remove the attribute, and the importer fixture table.
- Test: `packages/core/test/imports/rewrite.spec.ts`. Every importer file of `imports/` (the scripts of `.vue` and `.svelte` files; not `.ucf` files, whose block imports never go through the rewrite) and of `rewrite-edges/` goes through `rewriteImportAttributes`. Checks: no `framework` key left and every other key kept, each `.ucf` specifier carries `?framework=<value>` exactly when the source had the attribute (the `expected.ts` rows), the output parses with oxc-parser, a second run changes nothing, every statement and identifier maps back to the same text, a JSON snapshot per file, `non-literal.ts` and `not-literal-options.js` give `framework-attribute-not-literal` at the right line and column, and `strings-and-comments.ts` and `syntax-error.mjs` come back unchanged. `resolveTarget.spec.ts` and the tsserver test run the new rows too; tsserver leaves out `non-literal.ts` until 3.8.
- Status: done

### 3.3 `resolveTarget()` in core: the full rules

- Build: M2 shipped `resolveTarget(importer, attribute, options)` in `packages/core/src/imports/resolveTarget.ts`, with `Importer {fileName, block?}`, `TargetChoice`, `TargetRule`, `DEFAULT_IMPORTERS` and the codes `framework-in-block`, `unknown-framework`, `no-target`. This step extends it, keeping that signature, those codes and the rule order:

  ```ts
  resolveTarget(importer: Importer | undefined, attribute: string | undefined, options?: ResolveTargetOptions): TargetChoice
  interface ResolveTargetOptions {frameworks?: readonly Target[]; framework?: Target; importers?: Record<string, Target>} // frameworks: new, default all
  importerFromId(id: string): Importer // new: module ids and virtual script names to an Importer
  ```

  - `importerFromId` derives `block` (spec 4.1): `X.ucf.react.tsx` (the module id and the virtual script share the name) is inside `<react>`, `X.ucf.svelte.svelte` inside `<svelte>`, a bare `X.ucf` or the same path with any query (a `X.ucf?vue&…` sub-request) inside `<vue>` (the Vue block keeps the real path, spec 4.3), and the virtual scripts `X.ucf.vue.ts`, `X.ucf.svelte.ts` inside their target.
  - No importer (a build entry, as in the M5 library build) skips the block and importer rules: the attribute, then `options.framework`, else `no-target`.
  - A result outside `options.frameworks` is `target-not-enabled`, naming the enabled targets. `target-not-enabled` joins `DiagnosticCode` and `TargetErrorCode` (3.2 already added `framework-attribute-not-literal`). `missing-target-block` and `target-not-built` are already there: M2 (2.8, 2.9) reports them in the editor, and 3.6 reports `target-not-built` in the build.
  - The TypeScript plugin keeps calling the same function (3.8).
  - Fixtures: `fixtures/apps/imports/react-only/` with its `tsconfig.json` (`frameworks: ['react']` in the plugin entry) and `not-enabled.ts` (`framework: 'svelte'`), and its `expected.ts` row (`target-not-enabled`).
- Deliverable: the one place the target rules live (spec 5: "the editor and the build cannot disagree").
- Test: `packages/core/test/imports/resolveTarget.spec.ts`, extended from M2's. For every row of `expected.ts`: the attribute from `rewriteImportAttributes(...).imports`, the options of its sub-project (the plugin entry of its `tsconfig.json`; 3.7's `vite.config.ts` uses the same values), the real file path through `importerFromId`. Plus the in-block importers: the module ids of `Card.ucf` for each target, and its virtual script names.
- Status: done

### 3.4 `react.check()`: block rules

- Build: the check half of the react row, `packages/core/src/blocks/react.ts`. It parses the block content with oxc-parser (`lang: 'tsx'`) and maps offsets through `contentStart` to `.ucf` line and column.
  - `react-no-default-export` is M1's check (1.4). This step adds the accepted form `export {default} from '...'` and the `default-forms` fixtures that pin every form: `export default function`, `export default class`, `export default <expression>` (arrow, `memo(...)`, an identifier), `export {X as default}`.
  - `framework-in-block`: any `with { framework }` on a `.ucf` import inside the block (spec 4.1), whatever its value, pointing at the attribute.
  - `react-syntax-error`: the parser's own errors, mapped into the `.ucf` file.
  - Fixtures: `packages/e2e/fixtures/components/react/errors/` `NoDefault.ucf`, `NamedOnly.ucf`, `AttrInBlock.ucf`, `SyntaxError.ucf`; `packages/e2e/fixtures/components/react/default-forms/` one file per accepted form.
- Deliverable: every host that calls `check` (the Vite plugin now, the language server later) reports these at the exact spot in the `.ucf` file. The language server leaves `react-syntax-error` and `framework-in-block` to tsserver, which reports both inside `.ucf` files (hybrid mode: one problem, one error).
- Test: `packages/core/test/blocks/react.spec.ts`. Each fixture through `splitBlocks` and the registry's `react.check`: the error files give exactly their code, line and column; every `default-forms` file gives none.
- Status: done

### 3.5 `react.build()`: the virtual module, styles and `$style`

- Build: the build half of the react row, same file.
  - A MagicString over the **whole** `.ucf` source, with everything outside the block removed. Edits use `.ucf` offsets, so the map points straight into the `.ucf` file.
  - After the directive prologue (a leading `"use client"` stays first, milestone 5 needs it), insert one `import '<cssId>';` per `<style>`, and `import $style from '<class map id>';` per module (a named module uses its name, `import classes from ...`). Two modules with the same name: the last wins, as in plugin-vue, and M1's `duplicate-style-module` reports it. A module name that is no identifier (`module="my-theme"`) gets no class map import, as the editor declares none.
  - Returns `VirtualFile = {ext: '.tsx', code, map}`.
  - Fixtures: `packages/e2e/fixtures/components/react/AllBlocks.ucf` (all three target blocks, `<style module>`, `<style module="classes">`, a global `<style>`), `UseClient.ucf`, `Directives.ucf` (two directives, one without `;`), `Unicode.ucf` (emoji and accents before JSX).
- Deliverable: the file plugin-react will compile, still without the scope transform.
- Test: `packages/core/test/blocks/react.spec.ts`. Snapshot of `build` output per fixture. The output parses with oxc-parser. No text of the `<vue>` or `<svelte>` block is in it. Three marked tokens map back to their exact line and column in the `.ucf` file (checked with M1's `@jridgewell/trace-mapping`).
- Status: done

### 3.6 Vite plugin: resolve and load the React target

- Build: in `packages/vite/src/`:
  - `multifront(options)` now returns `Plugin[]` (the pre plugin `multifront`; 3.7 adds the post plugin). `MultifrontOptions` gains `importers?: Record<string, Target>` (it is core's `ResolveTargetOptions`, passed to `resolveTarget` as is). `frameworks` keeps the spec default: all three.
  - `cache.ts`: `createUcfCache(contextOptions)` returns `{splitUcf(file): Promise<SplitResult>; loadUcf(file): Promise<UcfEntry>}`, `UcfEntry = {split, ctx}`. Splits once per file content; `loadUcf` also runs the shared kinds (`createBuildContext`), `splitUcf` (for `resolveId`) does not.
  - Core: `buildTarget(split, ctx, target): VirtualFile`, the host function that runs that target row's `check` and `build`. It throws `DiagnosticsError` (`diagnostics: Diagnostic[]`) with the splitter's errors and that block's own, `missing-target-block` without the block, `target-not-built` for a row with no `build`. Style errors stay with their style module, and other targets' blocks are not checked (as plugin-vue reports only the blocks it compiles). The Vite `load` hook and M5's library build both call it. `missingTargetBlockMessage(importer, file, target)` moves to core, so the build and the TypeScript plugin print the same text.
  - `@vitejs/plugin-react`, `react` and `react-dom` become optional peers of `@multifront/vite`, with the pinned devDependencies that satisfy them (like plugin-vue). Ranges: `react` and `react-dom` `^19.0.0` (spec 8: `ref` is a prop); plugin-react `^6.0.0` (spike check 1 passes from 6.0.0 on). `react-dom` also becomes a root devDependency (the fixture mounts with `react-dom/client`). Scope id from the path relative to `config.root` and `config.isProduction`; `production = config.isProduction`.
  - `resolveId` for a specifier whose path ends in `.ucf` (no query but `framework`): read `?framework=`, resolve the path with `this.resolve(..., {skipSelf: true})`, call `resolveTarget`, then check the file has that block (`missing-target-block`, naming the importer and the imported file). Return the id of spec 4.3 for all three targets. Our own ids pass through: the target ids (also as dev URLs) resolve to the real file plus their suffix, the style and class map ids (any other query) go to Vite's own resolver. In dev, a bare `.ucf` URL with no importer (or the root `index.html`, Vite's default) is the Vue id, and the file `load` watches, resolved from its own React module, is the real file. During the dependency scan (`options.scan`), return the same react id, and anything else (vue, svelte, an error) as external: the `config` hook adds a scan plugin `multifront:scan` to `optimizeDeps.rolldownOptions.plugins` whose `load` serves the `<react>` block for `/\.ucf\.react\.tsx$/` as `moduleType: 'tsx'`, so bare imports inside `<react>` blocks are optimized at startup (spike check 2: without it the scan fails on the missing file, and as an external they are optimized late).
  - `load`: the react id runs `buildTarget` (errors through `this.error` with `loc: {file, line, column}`, message `<message> (<code>)`), and adds the `.ucf` file with `this.addWatchFile` (the id names no file on disk, spec 4.3). A style id returns its CSS and map, or its `style.check` and compile errors. A class map id returns its JS. A vue or svelte id fails with `target-not-built` (milestone 4 removes vue from it, milestone 6 deletes it).
  - `vueCompiler.spec.ts` is updated for the array.
  - Test infra: fixture apps' `vite.config.ts` load `@multifront/vite` from source through `configLoader: 'native'` (`buildApp`, `APP_CONFIG_LOADER`) in an e2e worker run with `--conditions=source`.
  - Fixtures: `packages/e2e/fixtures/apps/react-basic/` (`index.html`, `src/main.tsx` with bare imports, `vite.config.ts` with `react()` and `multifront()`, error entries under `src/errors/`; the vue pick imports `?framework=vue`, the form 3.7's rewrite emits). the shared `fixtures/components/imports/` folder: `Icon.ucf` and `UsesIcon.ucf` (its `<react>` block imports `./Icon.ucf` with no attribute); M4 and M6 add their blocks to both. M2's `imports/VueOnly.ucf` is the missing-block case.
- Deliverable: `import AllBlocks from './AllBlocks.ucf'` in a `.tsx` file builds with real plugin-react.
- Test: `packages/e2e/build/react-target.spec.ts` (area: build). A real `vite build` of `react-basic`:
  - the bundle has AllBlocks and Icon; `UsesIcon` got the React Icon without any attribute (4.1);
  - no text from the `<vue>` or `<svelte>` blocks is in the bundle;
  - one CSS asset holds each style block exactly once;
  - the source map sends a marker in the output back to its line in `AllBlocks.ucf`;
  - the error entries fail with `missing-target-block` (naming both files), `react-no-default-export` at `NoDefault.ucf:line:column`, and `target-not-built` for a vue pick;
  - a dev server's dependency scan logs no error and discovers `react-dom/client` (the scan plugin).

  Plus `packages/core/test/blocks/index.spec.ts`: `buildTarget` on the react, missing-block and not-built cases.
- Status: done

### 3.7 Post plugin: the attribute moves into the id

- Build: `packages/vite/src/attributes.ts`, `attributesPlugin(options)`: the plugin `multifront:attributes`, `enforce: 'post'`, returned second by `multifront()`. Its `transform` has a code filter `/\.ucf/` and runs on JS-like ids (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx`, `.tsx`, `.vue`, `.svelte`, with or without a query; `.mts` since `importers` may name it). Core exports its `locate(source, offset)` for the line and column. It calls `rewriteImportAttributes` and reports errors with `this.error`. It runs before Vite's import analysis in dev and before Rolldown reads the imports in a build, so we never depend on Rolldown forwarding attributes.
  - It also calls `resolveTarget` on each rewritten import and reports a rule error at the import, with the same message as `resolveId` (`importErrorMessage` in `packages/vite/src/diagnostics.ts`): Rolldown gives `resolveId` no position, so only the transform can point a build error at the import. A file with a rewrite error reports only that one (one problem, one error), and an error names the first problem of the file. `resolveId` keeps its errors for the imports the transform never sees (a written `?framework=`, a `.ucf` entry, block imports) and `missing-target-block`.
  - The location is in the importer's own source, not the compiled code the hook gets: in dev Vite maps the position back through the source maps itself; in a build the plugin maps it with `this.getCombinedSourcemap()` and `@jridgewell/trace-mapping` (an exact-pinned dependency of `@multifront/vite`).
  - Fixtures: `fixtures/apps/imports/` (3.2), plus `no-default/ssr-entry.tsx` that imports `Card.ucf` with `framework: 'react'` and exports `render()` (`renderToString`), with its `expected.ts` row. Each sub-project gets its `vite.config.ts` (`react()` and `multifront()` with the same options as its `tsconfig.json` plugin entry): the root (for `src/`), `no-default/`, `custom-importers/`, `react-only/`. `filesOf(app, pattern)` in `packages/e2e/fixtures/index.ts` lists an app's importers, the configs left out by name; core's `resolveTarget.spec.ts` and `rewrite.spec.ts` use it.
- Deliverable: spec 4.4 for `.ts`, `.tsx`, `.js`, `.jsx` importers, in dev, build and SSR.
- Test: `packages/e2e/build/imports.spec.ts` (area: build). For every `.js`, `.ts`, `.mts`, `.tsx`, `.jsx`, `.vue` and `.ucf` row (`no-default/` gains `plain.js` and `importer.mts`; the root config also has `vue()`, so `Page.vue`'s script reaches the plugin; `.svelte` rows come with milestone 6, which adds `svelte()` to the configs):
  - **Dev:** a real dev server per sub-project with real plugin-react and `server.preTransformRequests: false`. `transformRequest` of the importer (a `.ucf` row: its React module), client and SSR: each `.ucf` import is now the expected id in source order (`/abs/Card.ucf.react.tsx`, `/@fs/abs/Card.ucf` for vue, `/abs/Card.ucf.svelte.svelte`), and no `with` or `framework` is left.
  - **Build:** a build of every react row per sub-project: no attribute in the output.
  - **SSR:** `ssr-entry.tsx` loaded through the SSR module runner and rendered with `react-dom/server` `renderToString`: the HTML is the card with its `$style.card` class; the SSR-transformed code has no attribute.
  - Error rows fail with their code and location (`file`, line, column in the importer's source), in dev and in a build.
  - Adds `@types/react-dom` as an exact-pinned root devDependency (`react`, `react-dom`, `@types/react` and `@vitejs/plugin-react` are already there, plugin-react since 3.1, `react-dom` since 3.6), the same version as `@multifront/vite`'s `react-dom` (3.6).
- Status: done

### 3.8 The TypeScript plugin uses the same rules

- Build: `@multifront/language-tools/typescript-plugin` calls `resolveTarget` from core with the same `frameworks`, `framework` and `importers` options, read from its tsconfig plugin entry. No copy of the rules stays in language-tools.
  - It also reports `framework-attribute-not-literal` where `rewriteImportAttributes` does (3.2), with the same message and span: `resolveUcfImport(ts, literal, containingFile, options, sourceFile)` runs the rewrite on the importer's text (once per file version, never on a `.ucf` importer, whose block imports never go through it), and an import with a rewrite error stays unresolved, as the build fails it. A file that does not parse gets no rewrite error: its compiler reports the syntax error.
  - The row loop moves from `packages/e2e/editor/tsserver.spec.ts` to `editor/imports.spec.ts`, which covers the `no-default/non-literal.ts` row.
  - The imports root `tsconfig.json` gets `allowJs`, so `.js` and `.jsx` importers sit in their own sub-project with its plugin entry. `no-default/importer.jsx` became `jsx-importer.jsx`: TypeScript leaves a `.jsx` out of a project that has a `.tsx` of the same name.
- Deliverable: one import, one answer, in the build and in the editor.
- Test: `packages/e2e/editor/imports.spec.ts` (area: editor). A real tsserver with our plugin over every `fixtures/apps/imports/` project; each importer's `projectInfo` names its nearest `tsconfig.json`. For every row the build (3.7) resolves to react (`.ts`, `.tsx`, `.js`, `.jsx`, `.ucf`), the import resolves to `Card.ucf` (its React script) with no error. Every error row gives exactly its error on the import; `framework-attribute-not-literal` at the rewrite's span with its message, also for `import()` options that are no object literal, in an unsaved buffer. Rows that pick vue or svelte give `target-not-built` until milestones 4 and 6 (their virtual scripts do not exist yet); `.vue` and `.svelte` importers come with them. Attribute rows are compared too (spike 1 kept per-import attributes in the types), except `mixed.ts`: types give both its imports the last one's framework, while the build follows each attribute (its cases stay in `tsserver.spec.ts`). An importer with a syntax error gets no rewrite error (an unsaved edit of `non-literal.ts`: `no-target`). Plus `bundle.spec.ts`: the bundled plugin pack reports the same error, so the rewrite runs on oxc-parser's wasm binding; and `seams.spec.ts`: `resolveUcfImport` on `non-literal.ts`, on `rewrite-edges/nested-dynamic.js` (the error goes to the inner import only), and on `react/errors/AttrNoJsx.ucf` (a block that parses as plain TypeScript is still `framework-in-block`).
- Status: done

### 3.9 Browser harness and first render

- Build: `packages/e2e/browser/lib/` (reuse whatever milestone 1 shipped):
  - Copies come from M1's `copyApp(name)` (under `packages/e2e/.tmp/`); tests that edit files work on the copy.
  - `startDev(appDir): Promise<{url, server, close}>`, `buildAndPreview(appDir): Promise<{url, outDir, close}>`.
  - `launchChromium()`: uses `MULTIFRONT_CHROMIUM_PATH` when set. Its description in `scripts/lib/env.mjs` and `.env.sample` now covers the tests.
  - `collectConsole(page)`: every console message and page error.
  - CI: `pnpm exec playwright install --with-deps chromium` before the Test step in `.github/workflows/ci.yml` (CI splits `pnpm devx check` into steps), with `~/.cache/ms-playwright` cached by Playwright version.
  - `pnpm devx peer-floor <framework>`: reads the lowest version of each of that framework's peer ranges in `@multifront/vite` (for react: `react`, `react-dom`, `@vitejs/plugin-react`, plus the matching `@types/react` and `@types/react-dom`), writes them as pnpm `overrides` in `pnpm-workspace.yaml`, reinstalls, and checks every installed copy is at the floor. It changes the lockfile, so it runs in CI only (it refuses without `CI` set), on a throwaway checkout. The frameworks it knows are the rows of `FLOOR_PEERS` in `scripts/lib/peer-floor.mjs`: M4 and M6 add one each.
  - CI: a `react-floor` job: install, `pnpm devx peer-floor react`, Chromium, `pnpm devx test`. Every React test of this and later steps runs on both ends of the range, with no list to keep.
- Deliverable: Playwright against real served and built apps, and every React test on the oldest and the newest supported React, for this and every later milestone.
- Test: `packages/e2e/browser/react-render.spec.ts` (area: browser). `react-basic` in dev and in the production preview: AllBlocks renders; the `$style.card` class gives the computed `padding: 16px`; the `classes` module and the global style apply; no console errors. `react-basic`'s `index.html` names an empty icon, so the browser's favicon request is no 404.
  - Plus `packages/e2e/browser/harness.spec.ts`: `collectConsole` catches a real warning, error and page error; `launchChromium` names the fix when Chromium does not start.
  - Plus `packages/e2e/devx/peer-floor.spec.ts`: the react floor read from the real manifest, the overrides block on the committed `pnpm-workspace.yaml` (the floor job has already rewritten the working copy), the installed copies, and the refusals.
- Status: done

### 3.10 Scope transform: stamping

- Build: `packages/core/src/react/scope.ts`, called by `react.build` when `ctx.hasScoped`. Inserts only.
  - `packages/core/src/react/reactApis.ts`: the one file that names React APIs (the module `'react'`, `Fragment`, the wrappers `memo` and `forwardRef`). The scope code reads them from there, so a new React version edits this file only.
  - Every JSX opening element in the block gets ` data-v-<scopeId>=""` right after its name and type arguments (`<List<string> data-v-…="">`): host elements (lowercase, dashed custom elements, namespaced `svg:x`) and component elements (capitalized or member expression, like `<Foo.Bar>`).
  - Never on fragments: `<>`, `<Fragment>` and `<X.Fragment>` where `Fragment` or `X` comes from `'react'` (aliases followed through the imports, a local binding that shadows one followed too). React warns on extra Fragment props.
  - Fixtures: `packages/e2e/fixtures/components/react/scope/Stamped.ucf` (hosts, svg, `my-el`, `<Foo.Bar>`, a generic `<List<string>>`, a lookalike `<Ui.Fragment>`, both fragment forms, each named fragment once as a sole child (only there React checks Fragment props on mount), a `.map()` list, a generic `<T,>` and `a < b` in TSX, a scoped style). `packages/e2e/fixtures/apps/react-scope/` renders it. `scope/Namespaced.ucf` holds the `svg:x` elements and is built only: React's JSX transform rejects namespace tags in a Vite build. `scope/FragmentImports.ucf` (built only) pins every import form of React's Fragment (`{default as R}`, a quoted name, type-only, another module) and local bindings that shadow it, which get stamped.
- Deliverable: Vue's "every element in the template carries the scope id", for React.
- Test: snapshot through `react.build` in `packages/core/test/react/scope.spec.ts`. `packages/e2e/browser/react-scope.spec.ts` (area: browser), dev and preview: every DOM element from the block has `data-v-<id>`, the scoped rules apply (computed styles), and the console has no React warning.
  - The core spec also runs every scoped react fixture that checks clean (and fails when its list misses one): output parses, only inserts, one stamp per non-fragment opening element, mappings kept.
- Status: done

### 3.11 Root forwarding and the helper module

- Build:
  - `packages/core/src/react/scopeHelper.ts`: `SCOPE_HELPER_ID = 'virtual:multifront/scope-attrs'` and `scopeHelperCode(dev: boolean): string`. The Vite plugin serves it as `\0virtual:multifront/scope-attrs`. A few lines, bundled once:

    ```ts
    export function __ucfScopeAttrs(props) {
      const attrs = {};
      for (const key in props) if (key.startsWith('data-v-')) attrs[key] = props[key];
      return attrs;
    }
    // dev only: __ucfWarnFragment(props, name) warns once per component when a data-v-* prop came in
    ```

  - In `scope.ts`, find the default-exported component: follow an identifier to its module-level declaration; unwrap the wrappers of `reactApis.ts` (`memo`, `forwardRef`, `React.memo`, `React.forwardRef`), nested in any order; function or arrow, block or expression body.
  - Collect every `return` of that function (not of nested functions) and the expression body. Unwrap parentheses, TS `as` / `satisfies` / `!`, both branches of `?:`, the right side of `&&` / `||` / `??`, and one hop of `const x = <jsx>` in the same function.
  - Each JSX element root gets `{...__ucfScopeAttrs(<props>)}` right after its name. A component root forwards too, so the chain continues down, as in Vue.
  - A fragment root gets no forwarding. In dev it becomes `(__ucfWarnFragment(<props>, "Name"), <>...</>)`, Vue's multi-root warning. Nothing in production.
  - `null`, strings, calls and `children` get nothing (documented limitation, like third-party components).
  - `<props>` is the first parameter's name. With no parameter, `__props` is added; inside `forwardRef` it becomes `(__props, __ref)` so React's two-parameter check stays quiet.
  - Forwarding runs on every React component from a `.ucf` file, scoped style or not, so a parent's scope reaches a child that has no style of its own (spec 3.5.1). Stamping still needs `ctx.hasScoped`.
  - Fixtures: `packages/e2e/fixtures/components/react/shapes/` `MultiReturn.ucf`, `Ternary.ucf`, `NestedTernary.ucf`, `AndRoot.ucf`, `Memo.ucf`, `ForwardRef.ucf`, `MemoForwardRef.ucf`, `ExportIdentifier.ucf`, `ArrowExpression.ucf`, `NoParams.ucf`, `ConstRoot.ucf`, `ComponentRoot.ucf`, `FragmentRoot.ucf`, `NullRoot.ucf`. `fixtures/apps/react-scope/Parent.ucf` has a scoped style on the class each shape puts on its root, and renders each shape once per branch.
- Deliverable: a parent's scoped style reaches the root of a child `.ucf` component.
- Test: one snapshot per shape in `packages/core/test/react/scope.spec.ts`. `packages/e2e/browser/react-scope.spec.ts`, dev and preview, for every shape and branch: the child's root DOM element carries the parent's `data-v-<parent id>`, the parent's scoped rule applies to it (computed color), and a non-root element does not carry it. `FragmentRoot` logs exactly one warning in dev and none in preview. The `ForwardRef` ref still points at the DOM node.

### 3.12 Destructured props

- Build: in `scope.ts`, when the component's first parameter is a pattern:

  ```tsx
  export default function ScopedBadge({label, className = ''}: Props) { ... }
  // becomes
  export default function ScopedBadge(__props: Props) {const {label, className = ''} = __props; ... }
  ```

  - The pattern text is moved with MagicString, never re-printed, so defaults, rest and comments stay as written. The type annotation stays on `__props`.
  - An expression-bodied arrow gets `{ const ... = __props; return ... }`.
  - A parameter default stays on `__props`. A name clash picks `__props1`, `__props2`, ...
  - Forwarding then uses `__props`.
  - Fixtures: `shapes/Destructured.ucf`, `DestructuredArrow.ucf`, `DestructuredDefaults.ucf` (defaults, rest, annotation), `ForwardRefDestructured.ucf`. `packages/e2e/fixtures/components/react/ScopedPanel.ucf` (scoped style on `.badge`) and `ScopedBadge.ucf` (destructures `{label, className}`, root `<span className={className}>`).
- Deliverable: forwarding sees every prop, also for destructuring components.
- Test: snapshots in `packages/core/test/react/scope.spec.ts`. In `react-scope.spec.ts`: ScopedPanel's scoped `.badge` rule colors ScopedBadge's root span; defaults and rest props render as written.

### 3.13 Fuzz the scope transform

- Build: `packages/e2e/build/scope-fuzz.spec.ts` and the generator `packages/e2e/build/lib/scopeFuzz.ts`, written with the fuzzy-testing skill.
  - Seeded with M1's `MULTIFRONT_FUZZ_SEED` and `MULTIFRONT_FUZZ_RUNS`.
  - Writes real `.ucf` files to `packages/e2e/.tmp/fuzz/`, made by mutating and recombining the `shapes/` and `scope/` fixtures (rule 4 never renders `scope/Namespaced.ucf`'s namespace tags: React's JSX transform rejects them in a build): wrap the default export in `memo`, `forwardRef` or both; switch function and arrow, block and expression body; destructured, plain or no props; wrap a root in `?:`, `&&` or parentheses; add early returns; swap host and component tags; splice in children from another fixture; add comments, `a < b`, `<T,>`, non-ASCII text and a `"use client"` line; toggle `scoped`.
  - The generator records what it built (which roots are JSX elements), so the checks never redo the transform.
- Deliverable: confidence that the transform holds on shapes nobody wrote by hand. Each failure is shrunk and saved as a fixture in `fixtures/components/react/fuzz-found/`, with a snapshot added to 3.11's test.
- Test: CI runs 300 files with a fixed seed. Before the verdict (3.16), one long run: `MULTIFRONT_FUZZ_RUNS=10000 pnpm devx test packages/e2e/build/scope-fuzz.spec.ts`, with 10 seeds. Both green.
  - Rules checked, each with a negative control (a hand-broken output must make it fire once):
    1. **Parses:** the `react.build` output parses with oxc-parser with zero errors.
    2. **Only adds:** using the hires source map, the output characters that map into the `.ucf`, put back in source order, give exactly the block content. Every unmapped piece matches one of the fixed insert patterns (` data-v-<id>=""`, `{...__ucfScopeAttrs(...)}`, `__props`, `const ` / ` = __props;`, the arrow braces and `return `, the header imports, the dev fragment call).
    3. **Stamps:** with a scoped style, each non-fragment JSX opening element of the input carries exactly one ` data-v-<id>=""`.
    4. **Renders:** every 20th file is built with real Vite and real plugin-react for SSR, rendered with `react-dom/server` inside a parent that passes `data-v-parent=""`, once per branch. The outer element carries `data-v-parent` exactly when the generator built a JSX element root, and React logs no warning except the fragment one.

### 3.14 Demo app

- Build: `packages/e2e/fixtures/apps/demo/`, a real Vite React app (`index.html`, `src/main.tsx`, `src/App.tsx`, `vite.config.ts` with `react()` and `multifront()`). It renders:
  - `fixtures/components/Counter.ucf` (shared: M4 adds its `<vue>` content, M6 its `<svelte>` block): `useState` counter, `<style scoped>` and `<style module>` with `$style`, and a `<vue>` block (for the HMR test);
  - `ScopedPanel.ucf` with `ScopedBadge.ucf` (3.12);
  - `Card.ucf` imported with `with { framework: 'react' }` from a `.ts` helper, and bare from `App.tsx`.
- Deliverable: the app the exit test and milestone 4 build on ("same demo renders both").
- Test: `packages/e2e/browser/demo.spec.ts` (area: browser). Dev and preview render all three; computed styles match between dev and preview; no console errors. A dev cold start with an empty `node_modules/.vite` shows no "new dependencies optimized, reloading" after the first load.

### 3.15 HMR: style-only and target-only

- Build: `packages/vite/src/hmr.ts`, the Vite 8 `hotUpdate` hook, per environment, for `.ucf` files. Re-split the new source, compare block by block with the cache, return only what changed:
  - a `<style>` changed: its CSS module; plus the class map module if the class names changed;
  - the `scoped` flag or the number of `<style>` blocks changed: also the react module (stamping and imports change);
  - `<react>` changed: only the react module (plugin-react's Fast Refresh does the rest);
  - another target block changed: its module only if loaded (none in this milestone);
  - the bare `/abs/Card.ucf` module and its `?vue&…` sub-modules are always handed on untouched, so plugin-vue decides the Vue update (M4 relies on it);
  - nothing relevant: `[]`.

  The style and class map ids have `Card.ucf` as their path, so Vite lists them under that file; the react id names no file (spec 4.3), so its module is looked up by id (`environment.moduleGraph.getModuleById`). The cache is updated. The dev scope id does not depend on the source, so it stays stable across edits.
- Deliverable: spec 7's HMR rules for React.
- Test: `packages/e2e/browser/hmr-react.spec.ts` (area: browser), on a copy of `demo` (`copyApp`). Click Counter to 3.
  - Edit a declaration in its `<style scoped>`: the computed color changes, the count is still 3, the only requests are for that style module, and no `.ucf.react.tsx` module is requested again.
  - Edit text in `<react>`: the text changes, the count is still 3, no page load event, no style module requested again.
  - Edit the `<vue>` block: no request at all.

### 3.16 Exit test and the go / no-go verdict

- Build: `packages/e2e/browser/demo-exit.spec.ts` (below). Run the fuzz long run. Write the verdict in `docs/plan.md`, milestone 3: the result for each go criterion, and go or no-go. On no-go, the fallback below becomes the next steps, filed one todo per step.
- Deliverable: the decision, with evidence.
- Test: the exit test.

## Hands to later milestones

Core (`@multifront/core`):

- `resolveTarget(importer, attribute, options): TargetChoice`, `Importer`, `ResolveTargetOptions`, `TargetChoice`, `TargetRule`, `TargetErrorCode`, `DEFAULT_IMPORTERS`, `importerFromId(id)`. The vue and svelte rules are already in. Milestone 4 (`.vue` importers, the `<vue>` block's imports), 5 (library build with `framework` set), 6 (`.svelte` importers), 7 (`mf-tsc`).
- `rewriteImportAttributes(code, filename)`, `UcfImport`, and the rewritten form `./Card.ucf?framework=<target>`. Milestones 4 and 6 call it on `<script>` content if the spike verdict says plugin-vue or Svelte drop the attribute.
- The react row of the registry: `react.check(block, split): Diagnostic[]` and `react.build(block, ctx): VirtualFile` (`ext: '.tsx'`, map into the `.ucf`, directive prologue kept first). Milestone 5 (library build, `"use client"`), milestone 7 (language server diagnostics; `TSSERVER_CODES` in `@multifront/language-tools` lists the codes the server leaves to tsserver).
- `packages/core/src/react/reactApis.ts`: the React API names the transforms look for. Any later React-specific name goes there, never in another file.
- `SCOPE_HELPER_ID` (`'virtual:multifront/scope-attrs'`) and `scopeHelperCode(dev)`. Milestone 5 bundles it once per library build.
- The stamping rule: ` data-v-<scopeId>=""` on every host and component element, never on fragments; forwarding on every component, scoped style or not. Milestone 6 mirrors it in Svelte markup.
- Diagnostic codes: `react-no-default-export`, `react-syntax-error`, `framework-in-block`, `framework-attribute-not-literal`, `unknown-framework`, `target-not-enabled`, `no-target`, `missing-target-block`, `target-not-built`. Milestone 7 shows them in the editor. Milestone 4 removes vue from `target-not-built`; milestone 6 deletes that code.

Vite (`@multifront/vite`):

- `multifront(options): Plugin[]`, the plugins `multifront` (pre) and `multifront:attributes` (post), `MultifrontOptions.importers`. Every later milestone.
- `resolveId` already maps vue to the real `/abs/Card.ucf` and svelte to `/abs/Card.ucf.svelte.svelte`. Milestones 4 and 6 add `load` / `transform`.
- `packages/vite/src/cache.ts` `createUcfCache(contextOptions)` with `loadUcf(file): Promise<UcfEntry>` and `splitUcf(file)`, and core's `buildTarget(split, ctx, target)` (throws `DiagnosticsError`). Milestones 4, 5, 6.
- `packages/vite/src/hmr.ts`, with a target-only branch to fill per target. Milestones 4 and 6.

Tests and fixtures (`packages/e2e`):

- `packages/e2e/browser/lib/`: `startDev`, `buildAndPreview`, `launchChromium`, `collectConsole`, and Chromium in CI. Milestones 4, 5, 6.
- `pnpm devx peer-floor <framework>` and the `react-floor` CI job: milestone 4 adds `vue-floor`, milestone 6 `svelte-floor`.
- `fixtures/apps/demo/`: milestone 4 renders the Vue Card beside the React one, and adds visual parity.
- `fixtures/apps/imports/` with its `expected.ts` rows: milestones 4 and 6 add `.vue` and `.svelte` importer rows and their editor rows (`packages/e2e/editor/imports.spec.ts`).
- `fixtures/components/react/**` (shapes, scope, errors, imports, `ScopedPanel` / `ScopedBadge` / `AllBlocks`, and the shared `Counter.ucf` and `imports/`): milestone 5 packs them, milestone 6 copies the shapes for Svelte.
- The canary `packages/e2e/build/attributes-survive.spec.ts`: milestone 4 adds a plugin-vue row, milestone 6 a Svelte row.
- `packages/e2e/build/imports.spec.ts` and the `vite.config.ts` of each `fixtures/apps/imports/` sub-project: milestone 4 builds the `.vue` rows (the root config already has `vue()`), milestone 6 adds `svelte()` to the configs and the `.svelte` rows to the test.
- The fuzz runner pattern, `MULTIFRONT_FUZZ_SEED`, `MULTIFRONT_FUZZ_RUNS`: milestone 6 (Svelte stamping).
- The spike 3 verdict in `docs/plan.md`: milestones 4 and 6.

## Exit test

`packages/e2e/browser/demo-exit.spec.ts` (area: browser), on a copy of `fixtures/apps/demo/`, with a real Vite dev server, real `@vitejs/plugin-react` and Chromium:

1. The demo renders Counter, ScopedPanel with ScopedBadge, and Card. `$style` classes apply (computed styles).
2. Click Counter to 3. Edit its `<react>` block three times: each edit shows, the count stays 3, no page reload.
3. Edit a declaration in Counter's `<style scoped>`: the new computed value shows, the count stays 3, and no `.ucf.react.tsx` module is requested again.
4. ScopedPanel's scoped style reaches ScopedBadge's root span (computed color), and not an inner element.
5. `vite build` and preview of the same app: the same computed styles; no `with` or `framework` in any output file; each style block's CSS appears once.
6. The same Card rendered with `react-dom/server` through the SSR module runner: ScopedBadge's root span carries ScopedPanel's `data-v-*`.

**Go when all of these hold on CI (Linux, Chromium):**

1. The exit test passes in the `check` and `react-floor` jobs, and 20 times in a row locally (no flake).
2. Every `shapes/` fixture renders in dev and preview with its own `data-v-<id>` on every host element and the parent's `data-v-<id>` on its root DOM element (except `FragmentRoot` and `NullRoot`), with no React warning except the expected fragment one.
3. The fuzz long run (10,000 files, 10 seeds) finds no failure, with no change to the transform after it.
4. A style-only edit requests no `.ucf.react.tsx` module, and the state stays.
5. No `with { framework }` is left in any dev, build or SSR output of `imports`, and the build and tsserver agree on every react row.

**No-go when** criterion 2, 3 or the exit test's item 4 cannot be met without one of: data-flow analysis beyond the one `const` hop, a runtime wrapper component around user components, or patching or forking plugin-react. Also no-go when our injected code breaks Fast Refresh (criterion 1 or 4) and cannot be fixed in the module we emit.

A failure of criterion 5 alone is not a React no-go. It changes the import design (spike 3 verdict), not the scope transform.

**Fallback: CSS modules only for React.**

- Core drops the scope transform, `SCOPE_HELPER_ID` and the helper module (no trace, per AGENTS.md). `react.build` keeps only the style imports and `$style`.
- `react.check` gains `react-scoped-style`: a file with a `<react>` block and a `<style scoped>` is an error on the style block: "scoped styles do not work with the React target; use `<style module>` and `$style`". `<style module>` and global `<style>` keep working.
- Scoped styles stay allowed in files without a `<react>` block, so CSS stays identical across the targets a file has.
- A parent styles a child root only through a prop: `className={$style.badge}`, which the child merges on its root (spec 8 already asks roots to accept `className`). Exit test item 4 becomes "ScopedPanel's `$style.badge` passed as `className` styles ScopedBadge's root"; item 6 checks that class.
- Spec 2, 3.5 and 4.3 and `docs/plan.md` are updated; the example in spec 2 already uses `module`.
- Everything else of this milestone stays: `resolveTarget`, the attribute rewrite, the ids, HMR, the demo.
- Revisit later: the removed transform lives in git history and in the done spec of its step.

## Risks and open questions

Risks:

- **plugin-react and our id.** Fast Refresh must apply to `Card.ucf.react.tsx`. The spike showed it does on plugin-react 6.0.0 to 6.1.1, and that a `.ucf` path with a `lang.tsx` query is parsed without JSX in dev. The exit test guards it.
- **No file behind the React and Svelte ids.** Vite does not tie `Card.ucf.react.tsx` to `Card.ucf` on disk. `load` adds the `.ucf` file with `addWatchFile`, and `hotUpdate` (3.15) maps a `Card.ucf` change to those modules by id. Vite's own HMR never finds them.
- **The dependency scanner.** It reads importers before our post rewrite, so it sees `with { framework }` and bare `.ucf` imports, and reads every module from disk unless a scan plugin loads it. Imports that live only inside `<react>` blocks are optimized late (a reload) unless our scan plugin serves the block (3.6). Spike check 2 showed both; the cold start test in 3.14 guards it.
- **oxc-parser offsets.** If they are not UTF-16, edits land in the wrong place on non-ASCII files. Spike check 3, `Unicode.ucf`, and the fuzz.
- **Dev class names.** If M1's CSS-module class names hash the CSS text, every module style edit also changes the class map and re-runs the React module. Fast Refresh still keeps state, but "a style edit only reloads CSS" then holds for scoped styles only.
- **Stamped props on other components.** Third-party components get `data-v-*` as a prop; most pass it on or drop it. Vue does the same with fallthrough attributes. Fragments are skipped, since React warns there.
- **Two parses per React block** (ours and plugin-react's Oxc). Expected to be small next to the rest; watch the fuzz build times.
- **`@vue/compiler-sfc` in a React-only app.** Styles need it (spec 3.1), so React users must install it.
- **Scoped CSS of unused components.** Vite drops plugin-vue's scoped CSS when the bundle does not keep its component's default export: plugin-vue tags the style module `meta.vite.cssScopeTo`, and css-post skips it (Vite 8.2.2 `dist/node/chunks/node.js:22745-22747`). Our shared style modules carry no such tag, so a React build ships the scoped CSS of components no code uses. Tagging our scoped style modules with `cssScopeTo` pointing at the React module's default export would match.

Open questions:

3. Non-JSX roots (`return renderX()`, `return children`): silent, as planned, or a build warning? A warning would need a severity on `Diagnostic`.
4. Class components: stamped but not forwarded. Enough?
5. Opt-out of forwarding per component (spec 12): not in this milestone.

## Out of scope

- Loading and compiling the Vue and Svelte targets (milestones 4 and 6). Their ids resolve, and loading them fails with `target-not-built`.
- The library build, adding `"use client"`, `.d.ts` output (milestone 5). This milestone only keeps a directive first.
- SSR hydration and visual parity tests (once two targets exist, plan "Alongside every milestone").
- Forwarding through HOCs other than `memo` and `forwardRef`, through non-JSX roots, and in class components.
- `v-bind()` in CSS for React (spec 12).
- A `framework` attribute on a non-`.ucf` import.
- `mf-tsc`, Svelte markup completions, oxfmt and oxlint for `.ucf` (milestone 7).
