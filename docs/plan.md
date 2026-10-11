# Implementation plan

How we build [the spec](spec.md). How the pieces fit: [architecture.md](architecture.md).

## Packages

| Package | Job | When |
| --- | --- | --- |
| `@multifront/core` | Bundler agnostic: block splitter, style compile, scope ids, the target rules of spec 4.1 and 4.2, per-target transforms. Never imports Vite. | exists |
| `@multifront/vite` | The Vite plugin. Hands each target to plugin-vue, plugin-react or plugin-svelte, and rewrites import attributes. | exists |
| `@multifront/language-tools` | Everything that checks `.ucf` files without building them: the Volar language plugin (per-target virtual scripts), the TypeScript plugin (`./typescript-plugin`), the language server (`./server`), and the `mf-tsc`, `mf-lint` and `mf-fmt` commands. | exists |
| `packages/vscode` | The VS Code extension (Marketplace and Open VSX, not npm). Bundles `language-tools`; the one package not built by plain `tsc`. | exists |
| `packages/e2e` | Private, never published or built: the cross-package e2e tests, one folder per area, and the shared fixtures. | milestone 1 |

`@multifront/vite` also gets the library build (milestone 5): it is one Vite build per target, so it needs the plugin anyway.

**Why this split.** Packages follow who installs them and why. A package is added only when its milestone starts and needs it:

- `core` is only ever a dependency of the others; nobody installs it directly.
- `vite` is what an author adds to build: the plugin and the library build.
- `language-tools` is what an author adds to check: types, lint, format, the editor. The TypeScript plugin and the server are subpaths, not packages, so other editors (WebStorm, Neovim) can load them from the same install.
- `vscode` stays apart because it ships through a different store, not npm.

## Prototype first

Three unknowns can change the design. Each gets a throwaway spike before its milestone starts:

1. **Types by import attribute.** A tsserver plugin whose `resolveModuleNameLiterals` reads `with { framework }` from the import and resolves `./Card.ucf` to a per-target virtual script. If tsserver does not hand us the import node, fall back to the importer's framework and the default target only, and drop per-import overrides from the types (the build still honours them).

   **Answers** (milestone 2.1, run on TypeScript 6.0.3, `@volar/typescript` 2.4.28, Node 26.11.1, VS Code 1.141.0 whose tsserver runs on Electron's Node 24.21.0):

   1. **Yes, the import node is there.** Inside `resolveModuleNameLiterals`, `literal.parent` is the `ImportDeclaration`, the `ExportDeclaration` or the `import()` `CallExpression`, and `with { framework }` reads from it in all three. Only that one parent link is set at that point: pass the source file to `getStart()` / `getText()`. Per-import attributes stay in the types.
   2. **Expected limit: one resolution per (specifier, mode).** In one file, `./Card.ucf` with `react` then with `vue`: the plugin is asked for both and answers both, but the program keeps the last answer for both imports. Decision: one framework per specifier per file, in types only. The plugin warns on the second import and names the fix: one small re-export file per framework.
   3. **No.** Volar's tsserver plugin path never serves `getExtraServiceScripts`: it logs `getExtraServiceScripts() is not available in TS plugin.`, and an import resolved to `/abs/Card.ucf.react.tsx` is `TS2307`. Decision: in M2 the `.ucf` file's main service script is the React code, and React imports resolve to `/abs/Card.ucf` itself. Milestone 4 must solve per-target scripts before it adds Vue.
   4. **Yes, ESM loads, on two conditions.** tsserver loads a plugin with `require()`, so ESM works through `require(esm)` on Node 26 and inside VS Code. But tsserver skips a module that is not a function: the entry must export its factory as `'module.exports'` (`export default` alone is skipped). tsserver also finds the plugin with its own Node10 lookup, which ignores `exports`: `@multifront/language-tools/typescript-plugin` must be a real `typescript-plugin/` folder. An `index.js` there that imports the package's own `./typescript-plugin` export works, and Node applies `--conditions=source` to that import when the package is a workspace link. No bundled `.cjs` needed.
   5. **Yes.** No diagnostic on `framework` under `module: preserve` or `module: nodenext`, for static imports, `export ... from` and `import()`. Control: `module: es2020` gives TS's own `TS2823` / `TS1324` for any attribute, whatever the key.
   6. **Yes, hybrid mode works.** With `"languages": ["ucf"]`, VS Code sends `Card.ucf` to tsserver (`updateOpen`), and our plugin serves completion, hover and definition inside `<react>`. Rename and references cross `Card.ucf` and `App.tsx`. An unsaved prop rename in `Card.ucf` is a `TS2322` in `App.tsx` at once, in VS Code and over tsserver's `change` command.

   Cases 2.9 takes over (the spike script ran each one over tsserver's stdio protocol):

   - `main.ts`, `reexport.ts`, `lazy.ts`: the framework of each import kind reaches the resolver;
   - `mixed.ts`: both imports get the last import's file;
   - `App.tsx`: `quickinfo` on `<Card` shows `{ title: string }`; `definition` lands in `Card.ucf` inside `<react>`;
   - no diagnostic on the attribute under `module: preserve` and `module: nodenext`;
   - `Card.ucf` opened in tsserver: `completionInfo` and `quickinfo` inside `<react>`; `rename` on the prop lists `App.tsx`; `references` from `App.tsx` lists the use in `<react>`;
   - a `change` renaming the prop in `Card.ucf`, no save: `App.tsx` reports the old prop.
2. **A `<vue>` block in the editor.** Generate Vue virtual code from the block with `@vue/language-core` and map its offsets back into the `.ucf` file.

   **Answers** (milestone 4.1, run on `@vue/language-core`, `@vue/language-service` and `@vue/typescript-plugin` 3.3.11, all on `@volar/*` 2.4.28 like ours, TypeScript 6.0.3, Vue 3.5.42, Node 26.11.1). The spike made the same-length SFC code of `Card.ucf` and of `Counter.ucf` with a filled `<vue>` block (plus a CRLF copy), ran `createVueLanguagePlugin(...).createVirtualCode(fileName, 'vue', sfcCode)`, and nested the result under a root code beside the `react` and `style_N` codes. A scratch tsserver plugin served the nested `script_ts` as the `.ucf` file's script:

   1. **Yes, the codes build.** The `VueVirtualCode` gives `root_tags`, and under it `script_ts`, `scriptsetup_raw`, `template` (HTML), `template_inline_css`, `template_inline_ts_N` and `style_N`. No SFC error, and tsserver reports 0 diagnostics on `Card.ucf`, `Counter.ucf` and its CRLF copy. `{{ count.toFixed('x') }}` gives exactly one `TS2345`, at the `.ucf` range of `'x'` (line 10, columns 72 to 75, in LF and CRLF alike).
   2. **Yes, no shift.** A template expression (`{{ count }}`, `{{ title }}`), a `<script setup>` variable (`const count`) and a `$style` use (`$style.button`, `$style.card`) map from the `.ucf` offset into `script_ts` onto the same identifier and back to the same offset, in LF and CRLF. A template expression also has Vue's own extra mapping at its `__VLS_ctx.` prefix, as in a `.vue` file. tsserver `quickinfo` there shows `count: number`, `const count: Ref<number, number>` and `'button': string`. `definition` from `{{ count }}` lands on its declaration in `Counter.ucf`.
   3. **Nested as is: no. With a forwarding root: yes.** Vue's service plugins read `ir`, `fileName` and `vueCompilerOptions` from the **root** code. With our plain root, `vue-template` and `vue-compiler-dom-errors` throw `Cannot read properties of undefined (reading 'template')`, and no tag, attribute or directive completion comes. When the root also has getters for those four fields (`fileName`, `ir`, `vueSfc`, `vueCompilerOptions`) that read the nested code, everything works: `<sp|` offers `span`, `div` and the file's own `Counter`, `<span |class` offers `:id`, `@click` and `v-if` / `v-show` / `v-on`, hover on `<span` shows the MDN text, and no plugin throws. The `VueVirtualCode` stays nested (so `@vue/typescript-plugin`'s own `_vue:*` handlers, which need it as the root, are not used). The client answers through our own tsserver handlers, which call `@vue/typescript-plugin`'s request functions (`getComponentNames`, `getElementNames`, `getElementAttrs`, `getComponentProps`, `getComponentDirectives`) with the nested code. Two `instanceof VueVirtualCode` checks remain: tag and attribute name casing falls back to the setting's default instead of being read from the file, and Vue's initial-indent format options do not apply (decided: accepted, see the M4 doc's Risks). Nothing is offered in the blanked `<react>` region. **Decision:** the forwarding root, and Vue tag and directive completions stay in M4 (4.12).
      - Id clash: the SFC code keeps the root `<style>` blocks, so Vue emits `style_0`, `style_1` too. The root's id map keeps only the last code of each id (13 ids for 15 codes), so Vue's would shadow ours. **Decision:** the nested code leaves Vue's `style_N` children out (an instance getter over `VueVirtualCode`'s `embeddedCodes`). Our `style_N` codes serve the `<style>` blocks, and one CSS service answers once. `$style` typing comes from `script_ts`, so nothing is lost there.
      - `$style.buton` is no error with Vue's default `strictCssModules: false` (it types `$style` loosely). With `strictCssModules: true` it is `TS2551 Property 'buton' does not exist on type '{ button: string; }'`. **Decision:** our host sets `strictCssModules: true`, the same strictness as the React target's `$style`.
   4. **From `@vue/language-core`'s own `types/` folder.** `script_ts` starts with `/// <reference types="<typesRoot>/template-helpers.d.ts" />` and `props-fallback.d.ts`. `typesRoot` defaults to `../types` beside language-core's `lib/`, so an installed plugin finds both files in its own copy of language-core. The helpers import nothing, and `vue` resolves from the `.ucf` file's own project. Our generated code and the helpers always come from the same copy, so the user's Vue extension version does not matter. **But a bundle breaks it:** in a bundled plugin `__dirname` is `dist/`, the reference points at a missing `types/` folder, and the result is silent. Every `__VLS_*` helper type is missing (`TS2688`, `TS2304`, an implicit-any `$event`), but those errors sit in unmapped generated code, so the user sees no diagnostic. **Decision:** the bundle ships a copy of `@vue/language-core/types/*.d.ts` and sets `typesRoot` to it. With that, the bundled plugin has 0 raw diagnostics again. Built in 4.13: `pnpm devx vsix` copies them to `dist/vue-types/`, and the extension's plugin entry is `createTypeScriptPlugin({vueTypesRoot})`.

   Cases later steps take over (the spike script ran each one): the same-length invariant on LF and CRLF and the non-ASCII label (4.2); the one `TS2345` at `'x'`, in LF and CRLF, once 4.3 serves the Vue script beside the React one in tsserver; `$style.buton` as an error and one CSS answer per `<style>` block (4.3); the round trips and `definition` above, in LF and CRLF, tag, attribute and directive completions with no plugin error (4.12); and the helper files in the bundled plugin's program (4.13).
3. **Attributes surviving each compiler.** Check plugin-vue's script compile, the Svelte compiler and Oxc all keep `with { ... }` on imports, so our post rewrite still sees it.

   **Answers** (milestone 3.1, run on Vite 8.2.2, `@vitejs/plugin-react` 6.1.1, `@vitejs/plugin-vue` 6.0.8 with Vue 3.5.42, Svelte 5.57.0 with `@sveltejs/vite-plugin-svelte` 7.3.0, oxc-parser 0.149.0, Node 26.11.1). A recording post plugin read the code each importer reaches post plugins with:

   1. **Every compiler keeps the attribute.** `a.ts` and `b.tsx` (Oxc, plus plugin-react), `C.vue` (`<script setup lang="ts">` and a sibling `<script lang="ts">`), `D.vue` (plain `<script>`) and `E.svelte` (`<script lang="ts">` and `<script module lang="ts">`) keep `with { framework: 'react' }` on a static import, `export … from`, `export * from` and `import()`, in dev (`transformRequest`), dev SSR, a build and an SSR build. No change to spec 4.4, the architecture or M4 / M6: the post rewrite sees every importer kind. In a build, `C.vue`'s script reaches post plugins as `C.vue?vue&type=script&setup=true&lang.ts`, which 3.7's "with or without a query" covers.
   2. **The rewrite is needed even where Vite seems to cope.** Without it, Vite's import analysis drops the attribute of static imports and re-exports, but keeps `{ with: { framework } }` on `import()` in the dev output, client and SSR: the browser and Node would get it.
   3. **Check 1 fails: Vite cannot compile `/abs/Card.ucf?target=react&lang.tsx` in dev.** With plugin-react (6.0.0, 6.0.5, 6.1.0, 6.1.1), dev and dev SSR fail with `[PARSE_ERROR] Unexpected JSX expression`. Vite's `getModifiedOxcTransformOptions` (`dist/node/chunks/node.js:4145`) sets `lang: 'js'` for an id that matches plugin-react's `jsxRefreshInclude` (query allowed) while its path is not a JS file. Adding `/\.ucf$/` to plugin-react's `include` changes nothing; builds work. **Decision:** the React id is `/abs/Card.ucf.react.tsx` (spec 4.3), the same name as the editor's virtual script. It gets JSX and Fast Refresh in dev on every plugin-react 6.x, so the peer range starts at 6.0.0. The Svelte id follows for the same reason: plugin-svelte 7.3.0 leaves `/abs/Card.ucf?target=svelte&lang.svelte` uncompiled and compiles `/abs/Card.ucf.svelte.svelte` with its default filter. Cost: these ids name no file on disk, so `load` adds the `.ucf` file as a watch file and `hotUpdate` maps a change to the modules by id.
   4. **Check 2: the scanner needs a scan plugin.** Our `resolveId` gets `options.scan === true`. Returning `/abs/Card.ucf.react.tsx` during the scan, the scanner reads that path from disk and fails ("Failed to scan for dependencies"); returning it as external, a bare import found only in a `<react>` block is optimized after the first load ("dependency optimized: react-dom/client", a reload). **Decision:** our plugin adds an `optimizeDeps.rolldownOptions.plugins` entry whose `load` serves the `<react>` block as `moduleType: 'tsx'` for `/\.ucf\.react\.tsx$/` (those plugins run before Vite's scan plugins). Then the dep is optimized at startup and nothing is optimized late (3.6, 3.14). The scan's `resolveId` gets no import attributes from Rolldown, so the same entry's `transform` runs `rewriteImportAttributes` on importers first: a `.ucf` picked only by `with { framework }` is scanned too.
   5. **Check 3 passes.** oxc-parser node positions are UTF-16 offsets: after an emoji and accents, `<div` starts at 73, its UTF-16 index (UTF-8 byte offset 94). No conversion helper.

   The canary `packages/e2e/build/attributes-survive.spec.ts` keeps guarding answer 1 for `.ts` and `.tsx` with real plugin-react, in dev and SSR.

## Building on plugin-vue

We **compose** `@vitejs/plugin-vue`, never fork it. It is a peer dependency of `@multifront/vite`, and our plugin runs before it (`enforce: 'pre'`) so it only ever sees plain SFC code. What we learned reading plugin-vue 6.0.8:

1. **Borrow its compiler.** plugin-vue exposes `api.options.compiler`, filled in its `buildStart`. `getVueCompiler()` reads it, and falls back to core's `loadVueCompiler(root)`, which resolves `vue/compiler-sfc` from the project root the same way plugin-vue does (the editor uses it too). Done and tested. From plugin-vue's `buildStart` on, its compiler is our wrapper of it (item 5); `getVueCompiler()` unwraps it.
2. **The `vue` query is taken.** plugin-vue treats any id with a `vue` query as one of its own sub-requests (`Card.vue?vue&type=style`). Our internal React and Svelte ids carry no query at all (`Card.ucf.react.tsx`, `Card.ucf.svelte.svelte`, spec 4.3). Users never write a query; they use import attributes.
3. **No virtual `.vue` path.** On a cache miss (a dev server restart, SSR) plugin-vue reads the SFC from disk with `fs.readFileSync`, which fails for a file that does not exist. So the Vue target keeps the real `Card.ucf` path as the module id: we add `/\.ucf$/` to plugin-vue's `include` (its `api.include` setter, from our `configResolved`) and turn the `.ucf` source into SFC code in our pre `transform`. This is the pattern unplugin-vue-markdown uses with `.md` files. Three more pieces keep plugin-vue on our SFC code, never the raw file:
   - **The exclude.** plugin-vue's transform tests only the path, without the query, so it would compile our style and class map sub-requests as SFCs. `/\.ucf\?(?:.*&)?ucf\b/` goes into its `api.exclude`, which reaches its hook filter, and that sees the full id.
   - **The warm-up.** plugin-vue's descriptor cache lives at its module level and only its main transform fills it. On a miss (a fresh process, the first SSR request) it reads `Card.ucf` from disk and throws "At least one `<template>` or `<script>` is required"; after an in-process restart it still holds the old content. So our pre `load` of a `.ucf?vue&…` sub-request checks a per-process record of the source our transform last handed plugin-vue. A file missing from it, or changed on disk since, is first loaded with `this.load({id: '/abs/Card.ucf'})`: our transform and plugin-vue's main transform run and fill the cache, then plugin-vue loads the sub-request.
   - **The HMR `read` override.** plugin-vue's `handleHotUpdate` reads the changed file itself. `multifront:vue-hmr`, a pre plugin of its own (Vite never calls `handleHotUpdate` on a plugin with `hotUpdate`), sets `ctx.read` to return `vueSfcCode()` of the new content, so plugin-vue diffs SFC code against SFC code. It records the new source for the warm-up only when plugin-vue stores the new descriptor (a template or style change). plugin-vue re-renders with state kept only for `.vue` files, as it keeps a previous descriptor of no other file. So after a template-only change our post `transform` appends plugin-vue's own `export const _rerender_only = __VUE_HMR_RUNTIME__.CHANGED_FILE === "<file>"` line to the dev main module. plugin-vue's hook also returns only its own modules, so it gets the list without our `?ucf` modules, and our `hotUpdate` runs after it (`order: 'post'`) to add our changed modules back.
4. **One scope id for all targets.** plugin-vue hashes `sha256(relativePath + (production ? source : ''))`, first 8 hex chars. It also takes `features.componentIdGenerator`, so we set our own generator there and use the same one for React and Svelte. Same `data-v-*` everywhere, by construction. Other files keep the user's generator or plugin-vue's default. CSS module class names likewise: plugin-vue hands `<style module>` to Vite's CSS modules, so we set `css.modules.generateScopedName` to `<local>_<scopeId>_<index>` for `.ucf` style sub-requests (and the files they compose from), and keep the user's or Vite's own naming for every other file. Under `css.transformer: 'lightningcss'` each `.ucf` block gets the literal pattern `[local]_<scopeId>_<index>` the same way.
5. **Devtools show the `.ucf` file.** plugin-vue's `load` answers a sub-request (`?vue&type=script`, `?vue&type=style`) with the block and its map from compiler-sfc's `parse` or `compileScript`. Those maps carry the SFC code as their source text, other targets blanked, and Vite keeps the first map's text in a chain. So from a `buildStart` ordered after plugin-vue's, where it resolves its compiler, we set `api.options.compiler` to that compiler wrapped: `parse` and `compileScript` give their maps of a `.ucf` file the raw source behind the SFC code, read from the split cache when the map is used (plugin-vue keeps its compiled script while a same-length `<react>`-only edit leaves the SFC code the same). The positions stay right by construction (same-length code).

## Framework versions

- Our packages share one version (`version.json`), our own semver. It never copies a framework's number: one plugin serves three frameworks, and our fixes need numbers of their own. plugin-vue and plugin-react do the same.
- We never ship or run a framework compiler of our own. Vue: we borrow plugin-vue's. React: we hand plain `.tsx` to the user's plugin-react. So the user's versions are always the ones in use.
- Each framework and its Vite plugin is an optional peer range of `@multifront/vite`. React: `^19.0.0`. Vue: `@vue/compiler-sfc` `^3.5.15` (older ones break production template source maps, and before 3.5.12 use the legacy Sass API) and plugin-vue `^6.0.3` (6.0.0 to 6.0.2 refuse Vite 8). The Svelte range comes with its milestone.
- The framework API names our transforms look for live in one file per framework (`packages/core/src/react/reactApis.ts`). A new framework version edits that file only.
- CI tests each range at both ends: the pinned devDependencies (top) and `pnpm devx peer-floor <framework>` (bottom).
- A new framework major joins the range in a minor release of ours. Dropping one is a major release of ours.

## Milestones

Each milestone has a detailed document with ordered steps, deliverables and tests in [milestones/](milestones/README.md). Where it and the summary below differ, the milestone document wins.

### 1. Splitter, block kinds + styles

- The `BlockKind` contract and the registry in core ([architecture.md](architecture.md)), with `<style>` as the first full kind. Every later milestone fills in one row.
- `splitBlocks(source, filename)` in core: a hand-written scanner for top-level `<vue>`, `<react>`, `<svelte>`, `<style ...>`. Content is raw text up to the first matching closing tag.
- Errors carry `{code, message, line, column}`. The splitter: `duplicate-target`, `unknown-root-tag`, `unclosed-block`, `missing-target`, `text-outside-block`. `checkBlocks(split)` adds each kind's `check`: `react-no-default-export`, `style-inside-target`, `unknown-style-lang`, `duplicate-style-module`.
- `compileStyles(blocks, {id, filename})`: `compileStyleAsync` once per `<style>` (a `scoped` module block twice, CSS modules then scoped, as plugin-vue + Vite), returns CSS, map and the CSS-module class map.
- `scopeId(relativePath, source, production)`: the plugin-vue scheme above.
- Tests: splitter fixtures (`<>`, `<T,>`, `a < b`, `</react>` inside a string, duplicates, unclosed) and style snapshots (scoped, module, named module, scss).

### 2. Editor basics

- `packages/vscode`: `.ucf` language id, file icon, TextMate grammar embedding the Vue, TSX, Svelte and CSS / SCSS grammars. Highlighting in every block from day one.
- `language-tools`, the Volar language plugin: Embedded code for `<react>` (TSX) and `<style>` (CSS / SCSS), plus the `Card.ucf.react.tsx` virtual script with `$style` typed from the class names. A `.ucf` import inside the block resolves to the other file's React virtual script automatically.
- `language-tools/typescript-plugin`: `.ts` / `.tsx` files importing `.ucf` get the React types, using `resolveTarget()` from core (spike 1).
- `language-tools/server`: completions, errors, hover and go to definition inside `<style>` (CSS, SCSS), and our own diagnostics on the whole `.ucf` file. Inside `<react>` they come from tsserver with our plugin (hybrid mode).
- Tests: snapshots of the virtual code and its offset mapping; a tsserver test that a `.tsx` importer sees the right props.

### 3. React target and imports (go / no-go)

- `resolveTarget(importer, attribute, options)` in core: the spec 4.1 and 4.2 rules (automatic inside a block, attribute or importer outside), shared by the Vite plugin and the TypeScript plugin.
- Vite: resolve `.ucf` imports to the per-target ids of spec 4.3; a post plugin moves `with { framework }` into the id and removes it (static, re-export and dynamic imports; a non-literal value is an error).
- Virtual modules: style CSS, class map, and `Card.ucf.react.tsx`.
- Scope transform in core (oxc-parser + MagicString): stamp host and component elements, forward on returned roots (several returns, `?:`, `&&`, `memo`, `forwardRef`), rewrite destructured props, warn on fragment roots. The forwarding helper is a virtual module served by the Vite plugin, not a package.
- Tests: snapshot per JSX shape; a block importing another `.ucf` gets its own framework, and an attribute inside a block is an error; every outside rule and its order; no attribute left in dev, build or SSR output.
- Exit check: demo app renders the React Card; Fast Refresh keeps state; a style edit only reloads CSS; a parent scoped style reaches a child root.
- `react`, `react-dom` and plugin-react as optional peers; every React test also runs at the bottom of their range (`react-floor` CI job).
- If the scope transform is not reliable, fall back to CSS modules only for React and revisit.

**Verdict: go** (milestone 3.16, on Vite 8.2.2, oxc-parser 0.149.0, Node 26.11.1, Playwright 1.63.0's Chromium; React
and react-dom 19.3.0 with plugin-react 6.1.1 at the top of the range, 19.0.0 with 6.0.0 at the floor). The scope
transform stays; the CSS-modules-only fallback is not needed. Each go criterion of the milestone document:

1. **Exit test** (`packages/e2e/browser/demo-exit.spec.ts`): all 9 tests green in the `check` and `react-floor`
   jobs ([CI run 38115548476](https://github.com/MionKit/multifront/actions/runs/38115548476)), and 20 local runs in a
   row, 20 passed.
2. **Shapes:** `packages/e2e/browser/react-scope.spec.ts`, dev and preview. Every forwarded shape and branch carries
   the parent's `data-v-<id>` on its root DOM element only; FragmentRoot and NullRoot pass it to no element. The only
   React-side warning is FragmentRoot's, once, in dev. A shape's own stamp shows where it has a scoped style
   (MultiReturn); `scope/Stamped.ucf` pins it on every element kind. Shapes with no style carry none, as in Vue.
3. **Fuzz long run:** 10,000 files for each of seeds 1 to 10, no failure. Core and the Vite plugin did not change
   after the run.
4. **Style-only edit:** the exit test and `hmr-react.spec.ts`. No `.ucf.react.tsx` request, and the count stays.
5. **No attribute left:** `packages/e2e/build/imports.spec.ts` (dev client and SSR, build, SSR render) and the exit
   test's build output. `packages/e2e/editor/imports.spec.ts`: tsserver agrees with the build on every react row.

### 4. Vue target

- The composition described above: real `.ucf` id, plugin-vue `include`, shared `componentIdGenerator`.
- Editor: the `<vue>` block through `@vue/language-core` (spike 2), and `Card.ucf.vue.ts` for `.vue` importers.
- Tests: dev, build, SSR, a cache miss after restart, and one app importing the same file as React and Vue.
- Every test also runs at the bottom of the Vue ranges (`vue-floor` CI job).

### 5. Library build

- In `@multifront/vite`: one Vite library build per target with `framework` set, one JS file per component, real CSS files plus a combined `styles.css`.
- `"use client"` re-added per output file when the component uses hooks or event handlers.
- Types: `.d.ts` per target from the per-target virtual scripts. Writes each target's `package.json` with exports, types and peer deps only.
- Exit check: the packed React build works in a fresh Next.js App Router app and a fresh Vite React app.

### 6. Svelte target

- `Card.ucf.svelte.svelte` with the `$style` import, stamping via `svelte/compiler` `parse`, no Svelte `<style>`.
- Editor: `Card.ucf.svelte.ts` through `svelte2tsx`, for `.svelte` importers and the `<svelte>` block's types.
- Library output: uncompiled `.svelte` files + processed CSS + `.d.ts`.

### 7. Full editor support

- `mf-tsc` over every target, Svelte markup completions.
- oxfmt and oxlint for `.ucf` (spec 6.1): `mf-fmt` through oxfmt's `format()` API, block by block; `mf-lint` through temporary per-block files and oxlint's JSON output, while proposing `.ucf` support to oxc upstream. Both wired into the language server.

## Alongside every milestone

- HMR: style-only edits update only style modules; a target edit invalidates only that target.
- Visual parity test (Playwright) and SSR hydration test, once two targets exist.
- CI tests each framework peer range at both ends (see "Framework versions").

## Open questions

1. Target-only `<style>` inside a target block?
2. `v-bind()` in CSS for React / Svelte: drop, or CSS variables on the forwarded root?
3. Shared prop types: a root `<types lang="ts">` block?
4. Opt-out of scope attribute forwarding per component?
