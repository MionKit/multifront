# Milestone 4: Vue target

## Goal

A `.ucf` file with a `<vue>` block works as a real Vue component, in the build and in the editor.

- **Build:** the Vue target keeps the real `Card.ucf` path as its module id (spec 3.4, 4.3). Our pre `transform` turns the file into SFC code, and `@vitejs/plugin-vue` compiles it unchanged. Scoped CSS, `$style` and `v-bind()` work natively.
- **Same scope id everywhere:** plugin-vue's `features.componentIdGenerator` returns our `ctx.scopeId`. So `data-v-*` is the same for the Vue and React targets of one file.
- **Source maps and errors** point at the `.ucf` file.
- **plugin-vue cache misses** (dev server restart, SSR) and **HMR** read our SFC code, never the raw `.ucf` file.
- **One app, two targets:** the demo app renders the same file as React and as Vue, with the same styles.
- **Editor:** the `<vue>` block gets types, errors, hover and go to definition through `@vue/language-core`. `.ts` and `.vue` files importing a `.ucf` get the Vue type from `Card.ucf.vue.ts`. The `.vue` case works beside Vue's own TypeScript plugin (VS Code "hybrid mode").

### One idea used everywhere: same-length SFC code

To make the SFC code, we blank out everything that is not Vue. The text keeps its exact length and line breaks:

- the `<vue>` and `</vue>` tags become spaces;
- every other target block (`<react>…</react>`, `<svelte>…</svelte>`) becomes spaces, newlines kept;
- root `<style>` blocks stay as they are, with their original attributes.

```html
<vue>                      →       (5 spaces)
  <template>…</template>   →   <template>…</template>   (now a root block)
</vue>                     →       (6 spaces)
<react>export default …    →   (spaces, newlines kept)
<style module>…</style>    →   <style module>…</style>
```

The result is a valid SFC in which every character sits at the same offset, line and column as in `Card.ucf`. So:

- plugin-vue's source maps and error locations already point at the right `.ucf` line. Spec 3.4's "offset shift" is a shift of zero.
- `@vue/language-core` mappings are already in `.ucf` offsets, which makes spike 2 much smaller.
- `mf-lint` / `mf-fmt` (M7) can use the same code with no position mapping.

Blanking goes by UTF-16 code unit, and keeps every `\r` and `\n`, so CRLF files and non-ASCII text keep their positions.

## Needs from earlier milestones

From **M1** (splitter, block kinds, styles):

- `splitBlocks(source, filename)` and its block shape `{type, attrs, content, start, end, contentStart, contentEnd}`.
- `BlockKind`, `VirtualFile` and the two registries, `packages/core/src/blocks/index.ts` and its test that every tag has both halves.
- `ctx` as filled by the `<style>` kind, with `ctx.scopeId`. The `<vue>` kind also needs the file source and every split block from `ctx`. This document calls them `ctx.source` and `ctx.blocks`; use M1's names if they differ.
- The diagnostic shape `{code, message, line, column}` and the `style-inside-target` error (a `<style>` inside `<vue>`).
- `scopeId(relativePath, source, production)`. It hashes the **raw `.ucf` source**, not the SFC code.
- `getVueCompiler()` in `@multifront/vite` (exists).
- `packages/e2e` with `fixtures/components/`, `fixtures/apps/`, `build/`, `browser/`, `editor/`, registered in the root `vitest.config.ts`.

From **M2** (editor basics):

- `@multifront/language-tools`: the Volar language plugin that loops over `packages/language-tools/src/blocks/index.ts` and calls `editor()` per block.
- `@multifront/language-tools/typescript-plugin`: serves each kind's `types()` file as `Card.ucf.<target>.<ext>` (M2 ships `Card.ucf.react.tsx`) and resolves `.ucf` imports in `resolveModuleNameLiterals` with `resolveTarget()`.
- The in-block import rule: a `.ucf` import inside a block resolves to the other file's virtual script for the same framework (M2 built it for `<react>`).
- `@multifront/language-tools/server`, the language server.
- `packages/vscode`: the grammar already embeds `source.vue` for `<vue>`, and `contributes.typescriptServerPlugins` registers our TypeScript plugin.
- The `@volar/*` version M2 pins. `@vue/language-core` must be on the same `@volar/language-core`.
- M2's e2e helpers in `packages/e2e/editor/`: one that starts the real language server over LSP, one that starts a real tsserver with plugins. This document calls them `startLanguageServer()` and `startTsserver()`.

From **M3** (React target and imports):

- `resolveTarget(importer, attribute, options)` with the full spec 4.1 and 4.2 rules. That includes this one: an importer id that is the bare `/abs/Card.ucf`, or a `/abs/Card.ucf?vue&…` sub-request, is inside the `<vue>` block, so its imports get `vue`.
- The Vite plugin resolving a `vue` pick to the bare `/abs/Card.ucf` id (spec 4.3), with the "file has no block for that framework" error. If M3 leaves the `vue` case as an error, step 4.4 lifts it.
- Every non-Vue id M3 creates has `target=` or `ucf` in its query (`?target=react&lang.tsx`, `?ucf&type=style&index=N&lang.css`, the class-map id). Step 4.4's exclude pattern relies on it.
- The per-file split cache, looked up by absolute filename, which holds the split and `ctx`.
- The post plugin that moves `with { framework }` into the id.
- The HMR hook, which must leave the bare `/abs/Card.ucf` module and its `?vue&…` sub-modules in the list it returns, so that plugin-vue decides the Vue update.
- The demo app, `packages/e2e/fixtures/apps/demo/` (the folder M3 creates).

New dependencies, all exact-pinned:

- `@vue/language-core` as a dependency of `@multifront/language-tools`.
- `@vue/typescript-plugin` (same release line as `@vue/language-core`) and `@vue/server-renderer` as root devDependencies, for tests.

## Steps

### 4.1 Spike 2: a `<vue>` block through `@vue/language-core` (throwaway)

- Build: a throwaway script, not merged, in a scratch branch. Make the same-length SFC code of a real `.ucf` by hand. Run `createVueLanguagePlugin()` from `@vue/language-core` and its `createVirtualCode()` on it. Put the result under a Volar root virtual code for the `.ucf` file, as an embedded code. Answer four questions:
  1. Do the generated embedded codes (`script_ts`, template) build without errors?
  2. Do their mappings land on the right `.ucf` offsets with no shift? Check three spots: a template expression, a `<script setup>` variable, a `$style.card` use.
  3. Do Vue's language service plugins (template tag, attribute and directive completions) work when the `VueVirtualCode` is **nested** under our root code, not the root itself?
  4. Where do Vue's global types (`__VLS_*`) come from when our host runs language-core, not Vue's?
- Deliverable: the answers, written into `docs/plan.md` "Prototype first", item 2, with the chosen path. The spike code is thrown away.
- Test: the spike script itself asserts the three round-trip offsets. It runs real `@vue/language-core` on a real fixture.
- **If it fails, here is what changes:**
  - *Question 3 fails* (Vue's services need a `VueVirtualCode` root): step 4.12 ships TypeScript features only (errors, hover, definition, completions inside template expressions, `$style`), plus HTML completions from the HTML service on the template code. Vue tag and directive completions move to M7 and are listed in "Hands".
  - *Question 1 or 2 fails* (no usable code or mappings): the `<vue>` block keeps M2's highlighting only. `types()` builds `Card.ucf.vue.ts` from `compileScript()` of `@vue/compiler-sfc` instead (a `defineComponent` with the `defineProps` types), so importers still get types. Steps 4.12 and the in-block parts of 4.13 move to M7, and spec section 11 is updated.
  - *Question 4 is awkward*: our host writes the global types file the way `vue-tsc` does, and the TypeScript plugin adds it to the project.

### 4.2 `vueSfcCode()` in core

- Build: `packages/core/src/blocks/vue.ts` exports `vueSfcCode(source, blocks): {code, map}`. It returns the same-length SFC code described in "Goal", with MagicString edits and a hires map back to the `.ucf` file. Exported from `@multifront/core`.
- Deliverable: one function that turns a split `.ucf` into SFC code that plugin-vue and language-core can both read.
- Test: `packages/core/test/blocks/vue.spec.ts`. New fixtures go in `packages/e2e/fixtures/components/vue/`:
  - `Counter.ucf`: `<vue>` and `<react>` blocks, one `<style scoped>` with `v-bind()`, one `<style module>`, and a CRLF copy, `CounterCrlf.ucf`;
  - `Icon.ucf`: `<vue>` and `<react>`;
  - `ReactOnly.ucf`: no `<vue>` block.

  Each SFC code goes through the real `parse()` of `@vue/compiler-sfc`. The test checks that the descriptor has the template, the script setup and both styles with their original attributes, and no custom blocks. It also checks `code.length === source.length`, and that `descriptor.template.loc.start.line` equals the template's line in the `.ucf` file.

### 4.3 The `<vue>` block kind, both halves

- Build:
  - `packages/core/src/blocks/vue.ts` gains `vueBlock: BlockKind`, with `tag: 'vue'` and `role: 'target'`.
  - `grammar: {scopeName: 'source.vue'}`, the scope name M2's grammar already embeds, so the generated grammar does not change.
  - `check()` adds `vue-empty-block` (no top-level `<template>` or `<script>`). It uses the same raw scan as `splitBlocks`, so core still imports no compiler. Every other Vue error comes from compiler-sfc, already at the right line thanks to the same-length code.
  - `build(block, ctx)` returns `{ext: '.vue', ...vueSfcCode(ctx.source, ctx.blocks)}`.
  - `packages/language-tools/src/blocks/vue.ts` gains the editor half, from the spike's chosen path. `editor()` returns the `VueVirtualCode` of the same SFC code as embedded code. `types()` returns its generated script as `Card.ucf.vue.ts`.
  - Both halves are registered in the two registries.
- Deliverable: `<vue>` is a full row of the grid. The registry "both halves" test passes with it.
- Test:
  - Fixture `packages/e2e/fixtures/components/vue/Empty.ucf` (a `<vue>` block with only a comment).
  - `packages/e2e/editor/vue-block.spec.ts`: start the real language server with `startLanguageServer()` and open `Counter.ucf` with a wrong type in a template expression (`{{ count.toFixed('x') }}`). Expect one diagnostic at that exact `.ucf` range. `Empty.ucf` gives `vue-empty-block` at its line.

### 4.4 Compose plugin-vue: real path, include, exclude, pre transform

- Build: `packages/vite/src/vueTarget.ts`, called from our `configResolved` (it runs before plugin-vue's `options` hook, the last moment its `api.include` setter allows):
  - Find plugin-vue by name (`vite:vue`, as `getVueCompiler()` does).
  - Add `/\.ucf$/` to `api.include`, keeping the user's patterns.
  - Add `/\.ucf\?(?:.*&)?(?:target=|ucf\b)/` to `api.exclude`. plugin-vue's transform tests only the path, without the query, so without this it would compile `Card.ucf?target=react&lang.tsx` and the style modules as SFCs. The exclude goes into its hook filter, which sees the full id.
  - Our pre `transform` handles only the bare `.ucf` id (no query). It returns `vueBlock.build()` from the cached split.
  - When a `.ucf` resolves to `vue` and plugin-vue is not in the plugin list, the build fails with "the vue target needs @vitejs/plugin-vue in your Vite plugins", naming the importer.
- Deliverable: `import Counter from './Counter.ucf'` in a Vue app builds and runs.
- Test: new app `packages/e2e/fixtures/apps/vue/`, with Vite, plugin-vue, `multifront()`, an `App.vue` and a `main.ts`. In `packages/e2e/build/vue-compose.spec.ts`, a real `vite build`, run with plugin-vue listed both before and after `multifront()`. It checks:
  - the output has the compiled render of Counter and the `useCssVars` call from `v-bind()`;
  - a marker string from the `<react>` block is absent;
  - the build without plugin-vue fails with the error above;
  - a user's own plugin-vue `include` is kept: with `vue({include: [/\.vue$/]})`, the app's `Plain.vue` (a plain SFC, added here) and `Counter.ucf` both compile.

### 4.5 One scope id for every target

- Build: in `vueTarget.ts`, set `api.options.features.componentIdGenerator` to our generator.
  - For a `.ucf` file, it returns `ctx.scopeId` from the split cache. It ignores the SFC code plugin-vue passes, because the id must hash the raw `.ucf` source.
  - For any other file, it calls the user's generator if one was set (a function, `'filepath'` or `'filepath-source'`). Otherwise it uses plugin-vue's default (`getHash(path + (production ? source : ''))`), so plain `.vue` files keep their ids.
- Deliverable: the same `data-v-*` for a file's Vue and React targets, in dev and production.
- Test: `packages/e2e/build/vue-scope-id.spec.ts`.
  - Build `Counter.ucf` as Vue (`apps/vue`) and as React (`apps/demo`), in production and in development mode. Read the `data-v-*` from each output. They are equal.
  - A plain `Plain.vue` in `apps/vue` gets the same id with and without `multifront()` in the plugin list.

### 4.6 Source maps and error locations

- Build: no new mapping code is expected, thanks to the same-length SFC code. This step is the proof, plus any fix it finds. It also passes the map from 4.2 through our transform, so Vite chains it.
- Deliverable: devtools, stack traces and build errors point at `Counter.ucf`.
- Test: `packages/e2e/build/vue-sourcemaps.spec.ts`, with fixture `fixtures/components/vue/TemplateError.ucf` (an unclosed tag on a known line).
  - A production build with `build.sourcemap: true`: trace a template expression and a `<script setup>` statement with `@jridgewell/trace-mapping`. Both land on `Counter.ucf` at the original line and column.
  - A dev server with `css.devSourcemap: true`: the map of the scoped style sub-module points at the `<style>` line in `Counter.ucf`.
  - Building `TemplateError.ucf` fails, and the error names `TemplateError.ucf:<line>:<column>` of the bad tag.

### 4.7 plugin-vue cache misses: warm-up before sub-requests

- Build: a pre `load` hook in `vueTarget.ts` for `.ucf?vue&…` ids.
  - On a cache miss, plugin-vue reads `Card.ucf` from disk and throws "At least one `<template>` or `<script>` is required" (checked in plugin-vue 6.0.8).
  - So we keep a per-process record of which file contents we have handed to plugin-vue. If a sub-request comes for a file not in the record, we first `await this.load({id: '/abs/Card.ucf'})`. That runs our transform and plugin-vue's main transform, which fills its descriptor cache. Then we return nothing, and plugin-vue loads the sub-request from a warm cache.
  - Update `docs/plan.md` "Building on plugin-vue", item 3, to name the exclude, the warm-up and the HMR `read` override of 4.9.
- Deliverable: no request order and no restart can make plugin-vue read the raw `.ucf` file.
- Test: `packages/e2e/build/vue-cache-miss.spec.ts`. Each case is a fresh process (`vite` spawned from its CLI), so plugin-vue's module-level cache starts empty:
  - the **first** request to the dev server is `Counter.ucf?vue&type=style&index=0&scoped=…&lang.css` (the URL a page open before the restart holds). It returns the scoped CSS;
  - the same request goes through `server.environments.ssr.transformRequest()` as the first SSR request;
  - an in-process `server.restart()` after `Counter.ucf` changed on disk serves the new CSS;
  - a `vite build --watch` rebuild after a `<react>` block edit still builds (plugin-vue re-transforms only the cached sub-requests in watch builds).

### 4.8 SSR

- Build: `packages/e2e/fixtures/apps/vue/` gains `entry-server.ts` (`createSSRApp` and `renderToString` from `vue/server-renderer`), `entry-client.ts` (hydrate) and a small `server.ts` in Vite middleware mode. No change to `@multifront/vite` is expected. Any fix found here lands in this step.
- Deliverable: the Vue target renders on the server and hydrates on the client.
- Test:
  - `packages/e2e/build/vue-ssr.spec.ts`:
    - dev SSR through `server.ssrLoadModule()` in a fresh process: the HTML holds the Counter markup with the same `data-v-*` as the client build;
    - a production client build and an SSR build (`vite build --ssr`), as two separate processes: render the SSR bundle with Node, and check that its `data-v-*` matches the client CSS.
  - `packages/e2e/browser/vue-hydration.spec.ts`: Playwright loads the SSR page and clicks the counter. The count goes up, and the console has no hydration mismatch warning.

### 4.9 HMR for the Vue target

- Build: a third plugin in the array `multifront()` returns, `multifront:vue-hmr`, with `enforce: 'pre'` and only a `handleHotUpdate` hook.
  - For a `.ucf` file with a `<vue>` block, it sets `ctx.read` to return `vueSfcCode()` of the new content, the pattern VitePress uses for `.md`. It also refreshes the split cache first, so the scope id generator sees the new source.
  - plugin-vue seeds its HMR cache with our SFC code (`transformMain` does this for non-`.vue` files), so it diffs SFC code against SFC code.
  - It must be its own plugin: Vite passes `handleHotUpdate` plugins a different context object than `hotUpdate` plugins, and a plugin with `hotUpdate` never has its `handleHotUpdate` called.
- Deliverable: a `<vue>` edit is a Vue hot update, a `<style>` edit updates CSS only, and a `<react>` edit leaves the Vue component alone.
- Test: `packages/e2e/browser/vue-hmr.spec.ts`, Playwright on the `apps/vue` dev server, with real edits to a copy of `Counter.ucf`:
  - click the counter to 3, then edit text in the `<template>`: the text changes and the count stays 3 (re-render, no reload);
  - edit a color in the scoped `<style>`: the computed color changes, and the count stays 3;
  - edit the `<react>` block: no page reload and no Vue update (the `vite:beforeUpdate` payload has no `Counter.ucf` Vue module), and the count stays 3.

### 4.10 Imports from and into the Vue target

- Build: no new resolve code is expected. M3's `resolveTarget()` and post rewrite do the work. This step proves them with plugin-vue in the middle (spike 3 for plugin-vue's script compile), and fixes what it finds.
- Deliverable: the spec 4.1 and 4.2 rules hold for `.vue` importers and inside `<vue>` blocks.
- Test: `packages/e2e/build/vue-imports.spec.ts`, with new fixtures `fixtures/components/vue/UsesIcon.ucf` (its `<vue>` block imports `./Icon.ucf`) and `fixtures/components/vue/AttrInside.ucf` (a `framework` attribute inside `<vue>`). Real builds and dev SSR loads check that:
  - a bare import in `App.vue` gets the Vue target (importer rule);
  - `with { framework: 'vue' }` in `App.vue` survives plugin-vue's script compile and is gone from dev, build and SSR output;
  - `UsesIcon.ucf` renders the Vue `Icon` with no attribute;
  - `AttrInside.ucf` is a build error naming the file;
  - importing `ReactOnly.ucf` from `App.vue` is a build error naming both files.

### 4.11 One app, both targets

- Build:
  - The demo app `packages/e2e/fixtures/apps/demo/` gains plugin-vue and a Vue island. It mounts `Counter.ucf` as Vue (`import Counter from './Counter.ucf' with { framework: 'vue' }` in `mountVue.ts`) beside the existing React mount of the same file.
  - New helper `packages/e2e/browser/helpers/parity.ts` exports `expectSameComputedStyles(first, second, properties)` for two Playwright locators.
  - Update spec 4.3 on CSS: see "Risks", CSS twice.
- Deliverable: the demo renders the same file as React and as Vue, side by side (spec section 9, milestone 4).
- Test:
  - `packages/e2e/build/mixed-targets.spec.ts`: one `vite build` of the demo. The React chunk has no Vue render code, and the Vue chunk has no JSX runtime import from `Counter.ucf`. No `framework` attribute is left.
  - `packages/e2e/browser/parity.spec.ts`: both counters render with the same `data-v-*`. `expectSameComputedStyles()` matches padding, color, font size and border on the root and title elements. Clicking each counter changes only its own count.

### 4.12 The `<vue>` block in the language server

- Build: in `packages/language-tools/src/blocks/vue.ts` and the server setup:
  - turn on the services the spike approved for the nested Vue code (TypeScript, plus Vue's template services or the HTML service, per the 4.1 outcome);
  - `$style` and named modules are typed from the root `<style module>` blocks, which are present in the same-length SFC code, so language-core types them natively;
  - the in-block import rule for `<vue>`: `import Icon from './Icon.ucf'` in a `<vue>` block resolves to `Icon.ucf.vue.ts`.
- Deliverable: writing a `<vue>` block feels like writing a `.vue` file.
- Test: `packages/e2e/editor/vue-block-features.spec.ts`, real language server over LSP on `Counter.ucf` and `UsesIcon.ucf`:
  - hover on a `<script setup>` variable used in the template shows its type;
  - completion inside `{{ }}` lists it;
  - go to definition from the template lands on its declaration in the same `.ucf` file;
  - `$style.crad` is an error, and `$style.card` is not;
  - `<Icon :size="'big'" />` with a number prop is an error at that attribute;
  - per the spike outcome, either Vue directive completions (`v-if`) work, or the step says they moved to M7.

### 4.13 `Card.ucf.vue.ts` for `.ts` importers

- Build: in the TypeScript plugin, `.ucf` imports that `resolveTarget()` sends to `vue` resolve to `Card.ucf.vue.ts`, the `types()` file of 4.3. It exports a Vue `DefineComponent`. Global types are wired as the spike decided.
- Deliverable: a `.ts` file that picks Vue for a `.ucf` import gets the real Vue component type.
- Test: `packages/e2e/editor/vue-types.spec.ts`. Use `startTsserver()` with our plugin on `fixtures/apps/demo/`:
  - in `mountVue.ts`, quick info on `Counter` shows a `DefineComponent` with the `start: number` prop;
  - `h(Counter, {start: 'x'})` is an error;
  - with the plugin option `target: 'vue'`, a bare import in a `.ts` file resolves the same way;
  - a React importer of the same file still gets the React type.

### 4.14 `.vue` importers beside Vue's TypeScript plugin

- Build: how VS Code loads both plugins, and what we change.
  - Vue - Official ("hybrid mode") contributes `@vue/typescript-plugin` through `contributes.typescriptServerPlugins`. VS Code's TypeScript extension then starts tsserver with `--globalPlugins` and `--pluginProbeLocations` for each extension folder.
  - Our extension does the same for our plugin (M2). Both decorate the same language service host. Vue's plugin turns `App.vue` into TypeScript. Its imports, `./Counter.ucf` included, go through the host's `resolveModuleNameLiterals`, which ours wraps. The importer is `App.vue`, so `resolveTarget()` picks `vue`.
  - What to fix if needed:
    - `@volar/typescript` decorates a host only once per **module copy**. So our plugin must ship its own bundled copy, as the VS Code extension does, never share one with Vue's.
    - Our wrapper must pass every non-`.ucf` specifier through untouched.
  - `packages/vscode/README.md` says `.vue` importers need Vue - Official installed.
- Deliverable: in a `.vue` file, an imported `.ucf` component has its Vue type, with both extensions installed in either order.
- Test: `packages/e2e/editor/vue-importer.spec.ts`. Use `startTsserver()` the way VS Code does: `@vue/typescript-plugin` from its own install folder, ours from the bundled `packages/vscode` output, run in both orders, and once through `tsconfig.json` `compilerOptions.plugins`. Open `fixtures/apps/vue/src/App.vue`:
  - `<Counter :start="'x'" />` gives a type error at that attribute;
  - quick info on `Counter` is the Vue component;
  - go to definition lands in the `<vue>` block of `Counter.ucf`;
  - a plain `.vue` import in the same file keeps working.

## Hands to later milestones

- `vueSfcCode(source, blocks)` in `@multifront/core`: the same-length SFC code with a map. Used by **M7** (`mf-lint` / `mf-fmt` run on the `<vue>` block with positions 1:1, and `mf-tsc`).
- `vueBlock`, the `<vue>` row in both registries (`check`, `build`, `grammar`, `editor`, `types`), and the diagnostic code `vue-empty-block`. Used by **M5** (the Vue library build and its `.d.ts` from `Card.ucf.vue.ts`) and **M7** (`mf-tsc` checks the Vue target of every file).
- `packages/vite/src/vueTarget.ts`: plugin-vue composition (`include`, the exclude pattern `/\.ucf\?(?:.*&)?(?:target=|ucf\b)/`, `componentIdGenerator`, cache warm-up), and the `multifront:vue-hmr` plugin. Used by **M5** (`multifront({target: 'vue'})` plus `vue()` builds the Vue package unchanged) and **M6** (`?target=svelte` ids already pass the exclude, so the Svelte target needs no change here).
- `Card.ucf.vue.ts` through the TypeScript plugin, for `.ts` and `.vue` importers. Used by **M5** (Vue `.d.ts`) and **M7** (`mf-tsc` must also cover `.vue` importers, because `vue-tsc` does not load tsserver plugins).
- If spike 2 moved them: Vue tag and directive completions in the `<vue>` block. Used by **M7**.
- Fixtures: `packages/e2e/fixtures/components/vue/` (`Counter.ucf`, `CounterCrlf.ucf`, `Icon.ucf`, `UsesIcon.ucf`, `ReactOnly.ucf`, `Empty.ucf`, `TemplateError.ucf`, `AttrInside.ucf`), the app `packages/e2e/fixtures/apps/vue/` with SSR entries, and the demo app with a Vue island. Used by **M5** (base of the fresh Vite Vue consumer app) and **M6** (adds Svelte to the demo).
- `expectSameComputedStyles()` in `packages/e2e/browser/helpers/parity.ts` and `packages/e2e/browser/parity.spec.ts`. Used by **M6** (adds the Svelte counter to the same parity test).

## Exit test

`packages/e2e/browser/vue-exit.spec.ts`, on the demo app (`fixtures/apps/demo/`) plus `fixtures/apps/vue/`:

1. A production build of the demo renders `Counter.ucf` as React and as Vue in Playwright, with the same `data-v-*` and the same computed styles.
2. The Vue app's SSR build renders the Counter on the server and hydrates with no mismatch warning.
3. A fresh dev server process answers the Vue style sub-request as its first request, and a `<template>` edit hot-updates without losing state.
4. `startTsserver()` with Vue's plugin and ours reports the wrong prop type on `<Counter>` in `App.vue`.

## Risks and open questions

- **plugin-vue behavior we rely on that is not formal API:** the HMR `read` override, the cache-miss read from disk, the hook-filter `exclude` and the moment `api.include` locks. Every one is covered by a test in 4.4, 4.7 or 4.9, run on the CI matrix of supported plugin-vue versions. Worth proposing upstream: a plugin-vue option that hands it the SFC code of non-`.vue` files. That would remove the warm-up and the `read` override.
- **`handleHotUpdate` is on its way out** in Vite in favor of `hotUpdate`. When plugin-vue moves, our override must move with it, because the two hooks get different context objects. The 4.9 test fails first.
- **CSS twice in a mixed app.** The Vue target uses plugin-vue's own style modules (spec 3.4), while React uses ours. So an app importing one file as both ships its CSS rules twice. They are identical, with the same `data-v-*`, so rendering does not change, and library builds (one target each) are not affected. Spec 4.3 says CSS ships once. Open: accept it and reword spec 4.3, or rewrite plugin-vue's style imports to our shared style ids (which ties us to plugin-vue's output format).
- **Two Volar TypeScript plugins in one tsserver.** If both load from one `@volar/typescript` copy, the second never decorates the host. VS Code loads each from its own extension folder, so it works there. Other editors that hoist both into one `node_modules` may not. 4.14 tests both setups.
- **Version skew in the editor.** Our pinned `@vue/language-core` may differ from the one inside the user's Vue extension. The generated code is self-contained, but the global types may not be. The spike decides how we ship them.
- **Who resolves the bare `.ucf` id for `vue`**, M3 or this milestone. Listed under "Needs", with 4.4 as the fallback.
- **Dependency pre-bundling** does not scan inside `.ucf` files. A `vue` import first seen in a `<vue>` block may trigger one late re-bundle and a page reload in dev. Check during 4.4. If it shows, add `.ucf` to the scanner the way M3 does for `<react>`.
- **Same-length blanking** must keep every `\r`, `\n` and UTF-16 position. `CounterCrlf.ucf` and a non-ASCII string in `Counter.ucf` guard it.

## Out of scope

- The Vue library build, its `.d.ts` and its consumer app (M5).
- `mf-tsc`, `mf-lint`, `mf-fmt` for `<vue>` blocks (M7), and the `vue-tsc` view of `.vue` importers (M7).
- `v-bind()` in CSS for the React or Svelte targets (spec section 12).
- A `<style>` inside the `<vue>` block (stays the `style-inside-target` error).
- Vue custom elements (`.ce`), Vapor mode, Nuxt, and Vue custom blocks inside `<vue>` (they pass through to plugin-vue, but are not tested).
- Other editors than VS Code (only their tsserver setup is covered, by 4.14).
