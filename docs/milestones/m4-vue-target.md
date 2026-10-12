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
- `ctx` as filled by the `<style>` kind, with `ctx.scopeId`. The `<vue>` kind also needs the file source and every split block from `ctx`. M1's `BuildContext` has both: `ctx.source` and `ctx.split` (its `blocks`).
- The diagnostic shape `{code, message, line, column}` and the `style-inside-target` error (a `<style>` inside `<vue>`).
- `scopeId(relativePath, source, production)`. It hashes the **raw `.ucf` source**, not the SFC code.
- `getVueCompiler()` in `@multifront/vite` (exists).
- `packages/e2e` with `fixtures/components/`, `fixtures/apps/`, `build/`, `browser/`, `editor/`, registered in the root `vitest.config.ts`.

From **M2** (editor basics):

- `@multifront/language-tools`: the Volar language plugin that loops over `packages/language-tools/src/blocks/index.ts` and calls `editor()` per block.
- `@multifront/language-tools/typescript-plugin`: resolves `.ucf` imports in `resolveModuleNameLiterals` with `resolveTarget()`. M2 serves the React `types()` script (`Card.ucf.react.tsx`) as the `.ucf` file's own service script, because Volar's tsserver plugin does not serve `getExtraServiceScripts` (spike 1, answer 3). So 4.3 must first find another way to serve the Vue script beside it, a file that is not on disk.
- The in-block import rule: a `.ucf` import inside a block resolves to the other file's virtual script for the same framework (M2 built it for `<react>`).
- `@multifront/language-tools/server`, the language server.
- `packages/vscode`: the grammar already embeds `text.html.vue` for `<vue>`, and `contributes.typescriptServerPlugins` registers our TypeScript plugin.
- The `@volar/*` version M2 pins. `@vue/language-core` must be on the same `@volar/language-core`.
- M2's e2e helpers in `packages/e2e/editor/`: one that starts the real language server over LSP, one that starts a real tsserver with plugins. This document calls them `startLanguageServer()` and `startTsserver()`.

From **M3** (React target and imports):

- `resolveTarget(importer, attribute, options)` with the full spec 4.1 and 4.2 rules. That includes this one: an importer id that is the bare `/abs/Card.ucf`, or a `/abs/Card.ucf?vue&…` sub-request, is inside the `<vue>` block, so its imports get `vue`.
- The Vite plugin resolving a `vue` pick to the bare `/abs/Card.ucf` id (spec 4.3), with the "file has no block for that framework" error. If M3 leaves the `vue` case as an error, step 4.4 lifts it.
- Every non-Vue id M3 creates either has a path that does not end in `.ucf` (`/abs/Card.ucf.react.tsx`, `/abs/Card.ucf.svelte.svelte`) or has `ucf` in its query (`?ucf&type=style&index=N&lang.css`, the class-map id). Step 4.4's include and exclude patterns rely on it.
- The per-file split cache, looked up by absolute filename, which holds the split and `ctx`.
- The post plugin that moves `with { framework }` into the id.
- The HMR hook, which must leave the bare `/abs/Card.ucf` module and its `?vue&…` sub-modules in the list it returns (plugin-vue is in every M4 app), so that plugin-vue decides the Vue update.
- The demo app, `packages/e2e/fixtures/apps/demo/` (the folder M3 creates).

New dependencies, all exact-pinned. Each one arrives with the step that first imports it:

- `@vue/language-core` 3.3.11 (4.3), `@vue/language-service` 3.3.11 and `@vue/typescript-plugin` 3.3.11 (4.12) as dependencies of `@multifront/language-tools`. Spike 2 ran on them. All three use `@volar/*` 2.4.28, and `@vue/language-service` uses `volar-service-*` 0.0.71: the versions M2 pins. `@vue/typescript-plugin` also brings `vue-component-meta` 3.3.11. The server runs `@vue/language-service`'s plugins, and our TypeScript plugin calls `@vue/typescript-plugin`'s request functions (4.12).
- `@vue/typescript-plugin` 3.3.11 (4.14) as a root devDependency, for tests: 4.14 loads Vue's plugin from its own install folder. SSR (4.8) needs none: `vue/server-renderer` ships inside the root `vue`, so the `vue-floor` job renders with the floor's own copy.

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
- Verdict: 1 and 2 yes. 3 no with a plain root, yes when the root forwards `fileName`, `ir`, `vueSfc` and `vueCompilerOptions` to the nested code: the path 4.3 and 4.12 build. 4 comes from language-core's own `types/`, which a bundle must ship (4.13). Details in `docs/plan.md`, "Prototype first", item 2.
- Status: done

### 4.2 `vueSfcCode()` in core

- Build: `packages/core/src/blocks/vue.ts` exports `vueSfcCode(source, blocks, filename): {code, map}`. It returns the same-length SFC code described in "Goal", with MagicString edits and a hires map back to the `.ucf` file (`filename` is the map's source, as in the React build). Exported from `@multifront/core`.
- Deliverable: one function that turns a split `.ucf` into SFC code that plugin-vue and language-core can both read.
- Test: `packages/core/test/blocks/vue.spec.ts`. Fixtures (fixture names stay unique across `fixtures/components/`):
  - the shared `fixtures/components/Counter.ucf` (M3 made it with `<react>` and a `<vue>` block; this step fills its `<vue>` block for real), plus a CRLF copy, `vue/CounterCrlf.ucf`;
  - `vue/VBind.ucf`: a `<vue>` block and a `<style scoped>` with `v-bind()` (Vue only: spec 2 keeps `v-bind()` to the Vue target in v1);
  - the shared `fixtures/components/imports/Icon.ucf` gains its `<vue>` block;
  - `imports/ReactOnly.ucf`: no `<vue>` block.

  Each SFC code goes through the real `parse()` of `@vue/compiler-sfc`. The test checks that the descriptor has the template, the script setup and both styles with their original attributes, and no custom blocks. It also checks `code.length === source.length`, and that `descriptor.template.loc.start.line` equals the template's line in the `.ucf` file.
- Status: done

### 4.3 The `<vue>` block kind, both halves

- Build:
  - `packages/core/src/blocks/vue.ts`: `vueKind: BlockKind` (M1's name, beside `reactKind` and `styleKind`), with `tag: 'vue'` and `role: 'target'`.
  - `grammar: {scopeName: 'text.html.vue'}`, the scope name M2's grammar already embeds, so the generated grammar does not change.
  - `check()` adds `vue-empty-block` on the opening tag (no top-level `<template>` or `<script>`). It uses the same raw scan as `splitBlocks`, so core still imports no compiler. Every other Vue error comes from compiler-sfc, already at the right line thanks to the same-length code.
  - `build(block, ctx)` returns `{ext: '.vue', ...vueSfcCode(ctx.source, ctx.split.blocks, ctx.filename)}`.
  - `packages/language-tools/src/blocks/vue.ts`: `vueEditorKind`, the editor half (spike 2):
    - `editor()` returns the `VueVirtualCode` that `createVueLanguagePlugin(ts, compilerOptions, vueCompilerOptions, asFileName).createVirtualCode(fileName, 'vue', sfcSnapshot)` makes from `vueSfcCode()`, with its `id` set to `vue` (`createRootCode` sets every code's id). It is embedded under our root code, beside the `react` and `style_N` codes. `editor()` therefore returns `EditorCode[]` (`EditorFile | VirtualCode`), and `types()` may return `undefined` (no `ts`, no code).
    - `ts` and `compilerOptions` reach `editor()` through `EditorOptions`. In tsserver they come from the plugin's `info` (the host's `typescript` and `getCompilationSettings()`). In the language server, which never imports TypeScript, the server loads it from `initializationOptions.typescript.tsdk` (as M2 planned for the first service that needs it) and uses default compiler options.
    - The nested code leaves out Vue's own `style_N` children (an instance getter over `VueVirtualCode`'s `embeddedCodes`). They would share their ids with ours, and the root keeps one code per id. Our `style_N` codes serve the `<style>` blocks.
    - `vueCompilerOptions` sets `strictCssModules: true`, so `$style.buton` is an error, as it is in the React target.
    - New hook `serviceScript(code)`: the code tsserver serves as `Card.ucf.<tag>.ts`, found in what `editor()` made, with its ScriptKind. For `<vue>`: `script_ts` (`script_js` for a plain `<script>`).
    - `types()` returns that script as `Card.ucf.vue.ts`.
  - The TypeScript plugin serves a `.ucf` file's Vue script in tsserver **beside** the React one. M2 serves only the React script, because Volar's tsserver plugin has no extra service scripts (spike 1, answer 3). In hybrid mode only tsserver gives TypeScript results inside the `<vue>` block, so this step's test, 4.12 and 4.13 all need it. Spike 2 showed that the Vue `script_ts` works as a `.ucf` file's only tsserver script: 0 false errors, the right quickinfo and definition. What this step adds is serving both at once, in `packages/language-tools/src/targetScripts.ts`, for every kind with a `serviceScript`:
    - `Card.ucf.vue.ts` (`targetScriptName()`) is a program file of its own. The plugin decorates the project host before Volar binds it: `getScriptFileNames` adds it for each `.ucf` root, and each `.ucf` file the last program reached through an import; `getScriptSnapshot`, `getScriptVersion` (the `.ucf` file's), `getScriptKind` and `fileExists` serve it. tsserver keeps every program file's parse on a ScriptInfo, so the plugin creates one with `getOrCreateScriptInfoForNormalizedPath` (mixed content: no watcher) and attaches it.
    - One more Volar `Language` and proxy per served target, on the same base language service: `Card.ucf` is an associated-only source there, and `Card.ucf.vue.ts` a code whose `associatedScriptMappings` (plus Vue's `linkedCodeMappings`) map into it. Volar's own proxy then sends `Card.ucf` requests to it and maps the results back.
    - A router over Volar's main proxy: on a `.ucf` file the three diagnostics requests merge every script's results, a position request inside the `<vue>` content goes to the Vue proxy, everything else to the main one. A location Volar leaves in a target script (unmapped generated code) is dropped from definition, reference and rename results; a referenced symbol's definition and a highlight group point at the `.ucf` file instead, as Volar does for a `.vue` file.
  - The language server loads TypeScript from the tsdk only when it is a string that holds one; else it serves every block but `<vue>`'s code. The root plugin disposes the nested Vue code with its file.
  - The Vite plugin keeps a `vue` pick a `target-not-built` error until 4.4: `vueKind.build` now exists, but nothing compiles its SFC code yet.
  - Both halves are registered in the two registries.
  - Files with split errors: the editor is the first `vueSfcCode()` caller that reads them (the build stops at `buildTarget`). An unclosed target block is not in `split.blocks`, so `vueSfcCode()` leaves its raw text in place. The editor half must never hand that text to Vue's parser as SFC code: it blanks the ranges the splitter could not read as blocks (an unclosed block and the text after it up to the next root tag), the same way as other targets.
- Deliverable: `<vue>` is a full row of the grid. The registry "both halves" test passes with it. tsserver serves the React and the Vue script of one `.ucf` file side by side.
- Test:
  - Fixture `packages/e2e/fixtures/components/vue/Empty.ucf` (a `<vue>` block with only a comment). Core: `buildTarget()` throws `vue-empty-block` for it, and builds `Counter.ucf`'s vue row as `vueSfcCode()`.
  - `packages/e2e/editor/vue-block.spec.ts`:
    - `startTsserver()` with our plugin opens `Counter.ucf` with a wrong type in a template expression (`{{ count.toFixed('x') }}`). Expect exactly one diagnostic (`TS2345`), at the `.ucf` range of `'x'`. The same edit on `vue/CounterCrlf.ucf` gives the same diagnostic at its CRLF range.
    - `$style.buton` in the template gives exactly one `TS2551`, at `buton` (`strictCssModules`; `Counter.ucf`'s class is `button`).
    - In the same file, quickinfo inside `<react>` still shows the React types, inside `<vue>` the Vue ones, and definition from `{{ count }}` lands on its `<script setup>` declaration (both scripts are served).
    - Fixture `vue/VueWithUnclosedReact.ucf` (a valid `<vue>` block using `$style.box`, then a `<react>` block never closed, then a `<style module>`): tsserver reports nothing, and the language server only the splitter's `unclosed-block`, nothing from the `<react>` text.
    - `startLanguageServer()` with a tsdk: `Empty.ucf` gives `vue-empty-block` at its line. In `Counter.ucf` (it has a `<vue>` block) with a CSS error in its `<style scoped>`, expect exactly one CSS diagnostic there, and exactly one hover result on a property: Vue's `style_N` codes are left out.
    - Also: references, highlights and rename on a `<script setup>` binding stay in the `.ucf` file; a plain `<script setup>` is served as JavaScript; `imports/VueOnly.ucf`, reached only through an import in the `editor/` project, gets its `<vue>` diagnostics; the server's code tree has a `vue` code with a tsdk and none without.
  - `packages/e2e/editor/virtualCode.spec.ts`, on every fixture with a `<vue>` block (`invalid/` included): the `vue` code has no Vue `style_N`, its text keeps the source length and line breaks and nothing outside the `<vue>` content and root `<style>` blocks, and `getTypesScript(…, 'vue')` is the script it serves.
- Status: done

### 4.4 Compose plugin-vue: real path, include, exclude, pre transform

- Build: `packages/vite/src/vueTarget.ts`, called from our `configResolved` (it runs before plugin-vue's `options` hook, the last moment its `api.include` setter allows):
  - Find plugin-vue by name (`vite:vue`, as `getVueCompiler()` does).
  - Add `/\.ucf$/` to `api.include`, keeping the user's patterns.
  - Add `/\.ucf\?(?:.*&)?ucf\b/` to `api.exclude`. plugin-vue's transform tests only the path, without the query, so without this it would compile the style and class map modules as SFCs. The exclude goes into its hook filter, which sees the full id. The React and Svelte ids end in `.tsx` / `.svelte`, so `/\.ucf$/` never matches them.
  - Our pre `transform` handles only the bare `.ucf` id (no query). It returns `vueKind.build()` from the cached split, and the `target-not-built` guard 4.3 left in `load` goes.
  - When a `.ucf` resolves to `vue` and plugin-vue is not in the plugin list, the build fails with "the vue framework needs @vitejs/plugin-vue in your Vite plugins", naming the importer. A dev URL of the file (no importer) fails in our transform with the same message, naming the file.
  - The setters are called only when our pattern is not in the list yet: a second `configResolved` on the same plugins (an in-process `server.restart()`) comes after plugin-vue's `options` hook, where they throw.
  - The dependency scan follows a vue pick when plugin-vue is in the plugins. It resolves it to `Card.ucf.vue.ts` (scannable as `.ts`, and `importerFromId` puts its imports in the `<vue>` block), and our scan plugin loads it as `vueScanScript()`: `compileScript()` of the SFC code. The compiled script, not the raw one, because TypeScript stripping would drop an import only the template uses. `VueCompiler` gains `compileScript`.
- Deliverable: `import Counter from './Counter.ucf'` in a Vue app builds and runs.
- Test: new app `packages/e2e/fixtures/apps/vue/`, with Vite, plugin-vue, `multifront()`, an `App.vue` and a `main.ts`. In `packages/e2e/build/vue-compose.spec.ts`, a real `vite build`, run with plugin-vue listed both before and after `multifront()`. It checks:
  - the output has the compiled render of Counter, and the `useCssVars` call from `VBind.ucf`'s `v-bind()`;
  - a marker string from the `<react>` block is absent;
  - the build without plugin-vue fails with the error above;
  - a user's own plugin-vue `include` is kept: with `vue({include: [/\.vue$/]})`, the app's `Plain.vue` (a plain SFC, added here) and `Counter.ucf` both compile; a user's own `exclude` is kept too (`vue({exclude: [/VBind\.ucf$/]})` fails on `VBind.ucf`);
  - the exclude: `src/bothTargets.ts` re-exports `Counter.ucf` as vue and as react, and the build with it as an extra entry passes;
  - a dev server restart with the same plugin instances logs no error and still compiles `Counter.ucf` as Vue.

  Also: `build/react-target.spec.ts` gets the plugin-vue error for a vue pick and a dev URL in react-basic (no plugin-vue); `build/scan-deps.spec.ts` gains `importer.vue`, whose pick of `Mount.ucf`'s `<vue>` block (`lang="ts"`) finds `@jridgewell/trace-mapping`, imported there and used only in the template, and `vue-edges.vue`, which adds a template-only `<vue>` block and one `compileScript()` refuses: both are skipped, and the scan still finds it; the `imports/no-default` and `imports/custom-importers` configs gain `vue()` for their vue rows.
- Status: done

### 4.5 One scope id for every target

- Build: in `vueTarget.ts`, set `api.options.features.componentIdGenerator` to our generator.
  - For a `.ucf` file, it returns the file's scope id from the split cache's raw source (`scopeId(rootRelativePath(root, file), source, production)`, the inputs of `ctx.scopeId`; plugin-vue's generator is synchronous). It ignores the SFC code plugin-vue passes, because the id must hash the raw `.ucf` source.
  - For any other file, it calls the user's generator if one was set (a function, `'filepath'` or `'filepath-source'`). Otherwise it uses plugin-vue's default (`getHash(path + (production ? source : ''))`), so plain `.vue` files keep their ids.
- Also the CSS module class names: plugin-vue hands `<style module>` to Vite's CSS modules, which name classes their own way. For `.ucf` style sub-requests, `packages/vite/src/cssModules.ts` sets `css.modules.generateScopedName` (keeping the user's for other files) to M1's scheme `<local>_<scopeId>_<index>` (`moduleClassName()` in core), read from the sub-request's `index` and the cached source. So `$style.card` is the same class name in every target (M1 risk 1). A file the block composes from (`composes: x from './base.css'`) gets the block's names too, as in core: Vite's CSS plugin compiles the `.ucf` style sub-request inside an `AsyncLocalStorage` that names the block, because postcss-modules hands the generator only the composed file's path. With `css.transformer: 'lightningcss'`, Vite reads `css.lightningcss.cssModules` once per file inside that context, so a getter hands each `.ucf` block the literal pattern `[local]_<scopeId>_<index>` (grid, container and custom idents unhashed, as postcss-modules leaves them). Other files get exactly what Vite would give them: the user's function, a user's string pattern through `generic-names` (a dependency of `@multifront/vite`, the version Vite bundles), or postcss-modules' default.
- Deliverable: the same `data-v-*` and the same CSS module class names for a file's Vue and React targets, in dev and production.
- Test: `packages/e2e/build/vue-scope-id.spec.ts`.
  - Build `Counter.ucf` as Vue (`apps/vue`) and as React (`apps/demo`), in production and in development mode. Read the `data-v-*` from each output. They are equal.
  - `Plain.vue` in `apps/vue` gets the same id with and without `multifront()` in the plugin list.
  - `$style.button` renders the same class name as Vue and as React.
  - Also: a `<style module>` composing from other files (`vue/ComposesFile.ucf`) gets the same class names as Vue and as React; `css.transformer: 'lightningcss'` gives the same names as Vue; dev SSR, an SSR build, a watch rebuild and an app builder (with and without shared plugins) give the same names; the same after a dev server restart; with each user `componentIdGenerator` (unset, `'filepath'`, `'filepath-source'`, a function) and each user `css.modules` (unset, a `hashPrefix`, a string pattern, a function), `Plain.vue` keeps plugin-vue's own id and Vite's own `<style module>` class name, while `Counter.ucf` keeps ours.
- Status: done

### 4.6 Source maps and error locations

- Build: no new mapping code is expected, thanks to the same-length SFC code. This step is the proof, plus any fix it finds. It also passes the map from 4.2 through our transform, so Vite chains it.
  - Fix found: plugin-vue's sub-request maps (the build's `lang="ts"` script, every style) start from the SFC code it parsed, so devtools showed `Counter.ucf` with its other targets blanked. `wrapVueCompiler()` in `vueTarget.ts`, from our `buildStart` ordered after plugin-vue's (where it resolves its compiler), hands it back that compiler wrapped: `parse` and `compileScript` give their maps of a `.ucf` file a `sourcesContent` getter that reads the raw source from the split cache (`UcfVersion.sfc`, the SFC code our transform made from that version), read on use because plugin-vue keeps its compiled script across a same-length `<react>`-only edit. `getVueCompiler()` unwraps it. Positions do not change.
- Deliverable: devtools, stack traces and build errors point at `Counter.ucf`.
- Test: `packages/e2e/build/vue-sourcemaps.spec.ts`, with fixture `fixtures/components/vue/TemplateError.ucf` (an unclosed tag on a known line).
  - A production build with `build.sourcemap: true`: trace a template expression and a `<script setup>` statement with `@jridgewell/trace-mapping`. Both land on `Counter.ucf` at the original line and column.
  - A dev server with `css.devSourcemap: true`: the map of the scoped style sub-module points at the `<style>` line in `Counter.ucf`.
  - Building `TemplateError.ucf` fails, and the error names `TemplateError.ucf:<line>:<column>` of the bad tag.
  - Also: no mapping lands outside the `<vue>` content and the `<style>` blocks, and every map's source text for `Counter.ucf` is the file itself: in the build, in the dev style map, and in a watch rebuild after a `<react>`-only edit; a dev server restart wraps plugin-vue's compiler once.
- Status: done

### 4.7 plugin-vue cache misses: warm-up before sub-requests

- Build: a pre `load` hook in `vueTarget.ts` for `.ucf?vue&…` ids.
  - On a cache miss, plugin-vue reads `Card.ucf` from disk and throws "At least one `<template>` or `<script>` is required" (checked in plugin-vue 6.0.8).
  - After an in-process restart its cache still holds the old content of a file changed on disk.
  - So we keep a per-process record of which file contents we have handed to plugin-vue (`handedToVue()`, called by our transform). If a sub-request comes for a file not in the record, or whose content on disk differs, we first `await this.load({id: '/abs/Card.ucf'})` (`warmUpVue()`, from our pre `load`, after the `server.fs.allow` check). That runs our transform and plugin-vue's main transform, which fills its descriptor cache. Then we return nothing, and plugin-vue loads the sub-request from a warm cache.
  - Update `docs/plan.md` "Building on plugin-vue", item 3, to name the exclude, the warm-up and the HMR `read` override of 4.9.
  - The `vue-floor` CI job (M3 handed it to M4): `pnpm devx peer-floor vue` pins the bottom of the `@vitejs/plugin-vue` and `@vue/compiler-sfc` ranges, `vue` at the compiler-sfc floor, and runs every test there. The floor run moved two ranges: plugin-vue starts at `^6.0.3` (6.0.0 to 6.0.2 refuse Vite 8), `@vue/compiler-sfc` at `^3.5.15` in core, language-tools and vite (older ones break production template source maps, and before 3.5.12 use the legacy Sass API).
- Deliverable: no request order and no restart can make plugin-vue read the raw `.ucf` file.
- Test: `packages/e2e/build/vue-cache-miss.spec.ts`. Each case is a fresh process, so plugin-vue's module-level cache starts empty: `vite` spawned from its CLI, or, for the SSR and restart cases that need the server API, a Node script (`build/lib/freshProcess.ts`):
  - the **first** request to the dev server is `Counter.ucf?vue&type=style&index=0&scoped=…&lang.css` (the URL a page open before the restart holds). It returns the scoped CSS;
  - the same request goes through `server.environments.ssr.transformRequest()` as the first SSR request;
  - an in-process `server.restart()` after `Counter.ucf` changed on disk serves the new CSS;
  - a `vite build --watch` rebuild after a `<react>` block edit still builds, with the new production scope id in the CSS and the JS (plugin-vue re-transforms only the cached sub-requests in watch builds).

  Also: a dev server whose sub-requests follow the module, or arrive first and together, transforms `Counter.ucf` once (the record and a shared warm-up); `packages/e2e/devx/peer-floor.spec.ts` reads the vue floor.
- Status: done

### 4.8 SSR

- Build: `packages/e2e/fixtures/apps/vue/` gains `entry-server.ts` (`createSSRApp` and `renderToString` from `vue/server-renderer`), `entry-client.ts` (hydrate) and a small `server.ts` in Vite middleware mode. No change to `@multifront/vite` was needed.
  - `server.ts` (run as `node --conditions=source server.ts`) serves dev SSR only: `GET /` renders through `ssrLoadModule()` into a template inline in `server.ts`, its HMR websocket shares the server's port, and it prints `ssr server: <url>` once it listens on port 0. `index.html` and `src/main.ts` stay the client-only app (a hydrating entry there would warn on its empty container).
  - `build/lib/freshProcess.ts` gains `startNode()` (under `startViteCli()`), `finished()` on its handle (exit code 0) and `startSsrServer(root)`.
- Deliverable: the Vue target renders on the server and hydrates on the client.
- Test:
  - `packages/e2e/build/vue-ssr.spec.ts`:
    - dev SSR through `server.ssrLoadModule()` in a fresh process (`startSsrServer()`, `GET /` first): the HTML holds the Counter markup with the same `data-v-*` as the client module App.vue imports;
    - a production client build and an SSR build (`vite build --ssr`), as two separate processes: render the SSR bundle with Node, and check that its `data-v-*` and `$style.button` class match the client CSS.
  - `packages/e2e/browser/vue-hydration.spec.ts`: Playwright loads the SSR page from `server.ts` (the markup is in the response) and clicks the counter. The count goes up, and the console has no warning or error (a hydration mismatch is both).
- Status: done

### 4.9 HMR for the Vue target

- Build: a third plugin in the array `multifront()` returns, `multifront:vue-hmr` (`vueHmrPlugin()` in `vueTarget.ts`), with `enforce: 'pre'`, a `handleHotUpdate` hook and a post `transform`.
  - For a `.ucf` file our transform handed plugin-vue before, `handleHotUpdate` sets `ctx.read` to return `vueSfcCode()` of the new content, the pattern VitePress uses for `.md`. It refreshes the split cache first (`cache.updateUcf()`), which also gives the split to build from.
  - plugin-vue seeds its HMR cache with our SFC code (`transformMain` does this for non-`.vue` files), so it diffs SFC code against SFC code.
  - It also sets the new split cache version's `sfc` to that SFC code (4.6), so a style-only hot update, which re-transforms no main module, keeps the `.ucf` text in devtools.
  - plugin-vue re-renders (state kept) only for a `.vue` file: it keeps a previous descriptor of no other file, so a `.ucf` template edit would re-mount the component. `hotChange()` compares the SFC code last handed to plugin-vue with the new one (compiler-sfc `parse()`, parse errors kept as plugin-vue keeps them): only the template changed, and `shouldForceReload()` with the old script's imports (compiled with plugin-vue's own `script` options) is false, means a re-render. Then the post `transform`, after plugin-vue's, appends plugin-vue's own `.vue` line `export const _rerender_only = __VUE_HMR_RUNTIME__.CHANGED_FILE === "<file>"` to the dev client main module.
  - It records the new version as handed to plugin-vue (`handedToVue()`, 4.7) only when plugin-vue stores the new descriptor (a template or style change), so those sub-requests need no warm-up. After any other edit (a `<react>`-only one) plugin-vue keeps the old descriptor, old positions included, so the next sub-request warms it up.
  - It must be its own plugin: Vite passes `handleHotUpdate` plugins a different context object than `hotUpdate` plugins, and a plugin with `hotUpdate` never has its `handleHotUpdate` called.
  - A file imported both as Vue and as React: once plugin-vue holds its descriptor, its `handleHotUpdate` returns only its own modules. So `multifront:vue-hmr` hands it the list without our `?ucf` style modules (their URLs match its style lookup), and our `hotUpdate` runs `order: 'post'`, after it, adding our changed React, Svelte, style and class map modules back.
- Deliverable: a `<vue>` edit is a Vue hot update, a `<style>` edit updates CSS only, and a `<react>` edit leaves the Vue component alone.
- Test: `packages/e2e/browser/vue-hmr.spec.ts`, Playwright on the `apps/vue` dev server, with real edits to a copy of `Counter.ucf`:
  - click the counter to 3, then edit text in the `<template>`: the text changes and the count stays 3 (re-render, no reload);
  - edit a color in the scoped `<style>`: the computed color changes, and the count stays 3;
  - edit the `<react>` block: no page reload and no Vue update (the `vite:beforeUpdate` payload has no `Counter.ucf` Vue module), and the count stays 3.

  - edit the template to use the script's `ref` import: the component is mounted again (count back to 2), never re-rendered with a setup that lacks it.

  Also: `build/hmr.spec.ts` checks that with plugin-vue holding `Counter.ucf` a `<react>` edit still updates the React module and a `<style>` edit both its style modules; `build/vue-hmr.spec.ts` checks a fixed template typo and a `vue/GlobalProps.ucf` template edit (props typed through plugin-vue's `script.globalTypeFiles`) re-render, and a removed `<vue>` block fails then recovers; in `build/vue-sourcemaps.spec.ts`, the dev style map keeps the `.ucf` text after a `<style>` hot update, and maps to the new line after a `<react>` one that adds a line above the styles; in `build/vue-cache-miss.spec.ts`, the style sub-request of a `<style>` hot update transforms `Counter.ucf` no second time.
- Status: done

### 4.10 Imports from and into the Vue target

- Build: no new resolve code is expected. M3's `resolveTarget()` and post rewrite do the work. This step proves them with plugin-vue in the middle (spike 3 for plugin-vue's script compile), and fixes what it finds. It found two bugs:
  - A `framework` attribute inside `<vue>` was no error in dev, nor in a build of a script without `lang`. plugin-vue inlines those scripts into the bare `/abs/Card.ucf` module, which the post rewrite does not see. Fix: `vueKind.check` reports `framework-in-block` on each attribute in the block's `<script>` and `<script setup>` (oxc-parser on their content, as `react.check` does), so our pre `transform` fails at the `.ucf` position before plugin-vue, in every mode.
  - In a build, an import error of a `.vue` importer whose script plugin-vue does not inline (`lang="ts"`) pointed into the compiled `App.vue?vue&type=script…` module: plugin-vue makes no script map unless `build.sourcemap` is on. Fix: a fourth plugin in the array `multifront()` returns, `multifront:vue-importers` (pre, `vueImportersPlugin()` in `attributes.ts`), runs the post rewrite's checks on the raw `.vue` file's scripts (parsed with the borrowed compiler) and fails at the import in `App.vue` itself.
  - `apps/vue/src/App.vue` gains `import UsesIcon from '…/imports/UsesIcon.ucf' with { framework: 'vue' }` and renders it.
- Deliverable: the spec 4.1 and 4.2 rules hold for `.vue` importers and inside `<vue>` blocks.
- Test: `packages/e2e/build/vue-imports.spec.ts`, with the shared `fixtures/components/imports/UsesIcon.ucf` (this step adds its `<vue>` block, which imports `./Icon.ucf`) and `fixtures/components/vue/AttrInside.ucf` (a `framework` attribute inside `<vue>`). Real builds and dev SSR loads check that:
  - a bare import in `App.vue` gets the Vue target (importer rule);
  - `with { framework: 'vue' }` in `App.vue` survives plugin-vue's script compile and is gone from dev, build and SSR output;
  - `UsesIcon.ucf` renders the Vue `Icon` with no attribute;
  - `AttrInside.ucf` is a build error naming the file;
  - importing `ReactOnly.ucf` from `App.vue` is a build error naming both files.

  Also: `vue/AttrInsideJs.ucf` (a `<script setup>` with no `lang`) fails the same way; an unknown or non-literal framework in a `.vue` importer, with or without `lang="ts"`, fails a build with no source maps at the import in that file; `core/test/blocks/vue.spec.ts` checks `vue.check` on both `AttrInside` fixtures.
- Status: done

### 4.11 One app, both targets

- Build:
  - The demo app `packages/e2e/fixtures/apps/demo/` gains plugin-vue (`[react(), vue(), multifront()]`) and a Vue island. `src/mountVue.ts`, imported by `main.tsx`, imports `Counter` from `'../../../components/Counter.ucf' with { framework: 'vue' }` and mounts it on `#vue`, a container beside the React `#app` in `index.html`.
  - New helper `packages/e2e/browser/lib/parity.ts` exports `expectSameComputedStyles(first, second, properties)` for two Playwright locators.
  - The demo's older tests follow the island: `build/hmr.spec.ts` lists its own plugins (`configFile: false`), so its "without plugin-vue" cases stay so; `browser/hmr-react.spec.ts` expects plugin-vue's style sub-request beside ours on a `<style>` edit, and a `<vue>` edit to update only the Vue counter; `browser/demo-exit.spec.ts` counts Counter's CSS once per target (spec 4.3, "CSS twice in a mixed app").
- Deliverable: the demo renders the same file as React and as Vue, side by side (spec section 9, milestone 4).
- Test:
  - `packages/e2e/build/mixed-targets.spec.ts`: one `vite build` of the demo (one chunk). The React module of `Counter.ucf` imports nothing from `vue` and has no Vue render code; the Vue modules (the bare id and its `?vue&…` sub-requests) import no JSX runtime and have no `jsx`. No `framework` attribute is left.
  - `packages/e2e/browser/parity.spec.ts`, dev and preview: both counters render with the same `data-v-*`. `expectSameComputedStyles()` matches padding, color, font size and border on the root, title (`.label`) and button elements. Clicking each counter changes only its own count.
- Status: done

### 4.12 The `<vue>` block in the language server

- Build: in `packages/language-tools/src/blocks/vue.ts` and the server setup:
  - `createRootCode` (`src/languagePlugin.ts`) calls `forwardToVueCode()`: the root code gets getters `fileName`, `ir`, `vueSfc` and `vueCompilerOptions` that read the nested `vue` code, when the file has one. Vue's service plugins read those from the root, not from the code they serve (spike 2).
  - The tsserver relay. Our server sends each tsserver request to the client as the LSP notification `tsserver/request` `[id, command, args]`, as Vue's server does. The extension (`packages/vscode/src/extension.ts`) runs it through VS Code's `typescript.tsserverRequest` command and sends `tsserver/response` `[id, body]` back, `undefined` when the command fails (no TypeScript extension). `relayTsserver(server, tsserver)` in `packages/e2e/editor/lib/lsp.ts` links `startLanguageServer()` to `startTsserver()` the same way, so tests use the real relay path; the server handle's `log` keeps every message the server logged;
  - hybrid mode (M2): tsserver with our plugin serves the TypeScript features of the nested Vue code, through the Vue script 4.3 serves beside the React one. Our server adds `createVueLanguageServicePlugins(ts, client)` from `@vue/language-service`, minus its `css` plugin (`name: 'css'`), because our `volar-service-css` already serves the `<style>` blocks. The plugins run on the nested code through the root's forwarding getters. Three of them wait for Vue's root code id `main` (`vue-inlayhints`, `vue-document-highlights`, `typescript-semantic-tokens`) and stay idle on our `root`. `client` asks tsserver for type information, as Vue's own server does. Our TypeScript plugin answers through its own protocol handlers (`src/vueRequests.ts`, commands `_multifront:<request>`: VS Code's `typescript.tsserverRequest` passes commands starting with `_`), which call `@vue/typescript-plugin`'s request functions (`getComponentNames`, `getElementNames`, `getElementAttrs`, `getComponentProps`, `getComponentDirectives`) with the nested code and `Card.ucf.vue.ts` as its program file. Every other client request answers nothing, as with Vue's default client. Vue's own `_vue:*` handlers need a `VueVirtualCode` root, so they cannot serve `.ucf` files;
  - `$style` and named modules are typed from the root `<style module>` blocks, which are present in the same-length SFC code, so language-core types them natively;
  - the in-block import rule for `<vue>`: `Card.ucf.vue.ts` is an importer inside the `<vue>` block (`importerFromId()`), so `import Icon from './Icon.ucf'` there resolves to `Icon.ucf.vue.ts`, and a `framework` attribute there is `framework-in-block`. Other vue picks keep `target-not-built` until 4.13.
  - The shared `imports/Icon.ucf` gains a `size?: number` prop in its `<vue>` block; `imports/VueOnly.ucf` takes its place as the template-only case in `core/test/blocks/vue.spec.ts`.
- Deliverable: writing a `<vue>` block feels like writing a `.vue` file.
- Test: `packages/e2e/editor/vue-block-features.spec.ts`, the real tsserver with our plugin plus the real language server over LSP, linked by `relayTsserver()`, on `Counter.ucf` and `UsesIcon.ucf`:
  - hover on a `<script setup>` variable used in the template shows its type;
  - completion inside `{{ }}` lists it;
  - go to definition from the template lands on its declaration in the same `.ucf` file;
  - `$style.buton` is an error, and `$style.button` is not;
  - `<Icon :size="'big'" />` with a number prop is an error at that attribute;
  - hover and go to definition also on `vue/CounterCrlf.ucf`, at the same spots;
  - in the template, completion at `<sp|` lists `span`, `div` and the file's own component, and before an attribute it lists `:id`, `@click` and `v-if`;
  - no warning or error in the server log (with a plain root, `vue-template` throws reading `info.root.ir`);
  - in `Counter.ucf`'s `<style scoped>`, completion lists `color` once and its hover has its docs once (Vue's `css` plugin is left out; completion items are merged by label, a hover is not);
  - `vue/AttrInside.ucf` gets its two `framework-in-block` from tsserver alone: the language server leaves that code to tsserver (`TSSERVER_CODES`), and since 4.10 `vueKind.check` reports it too.
  - Also: `UsesIcon.ucf`'s `<vue>` import of `./ReactOnly.ucf` is `missing-target-block` naming `UsesIcon.ucf`; completion before the end of `<Icon />` lists its `:size` (`getComponentProps`); `_multifront:getComponentDirectives` lists Vue's directives; `class="counter"` links to `.counter` (`vueCompilerOptions`); a `<template>` never closed inside `<vue>` is Vue's SFC error at its tag (`vueSfc`); a relayed request that fails lands in the server log.

  Also, in real VS Code (`packages/e2e/editor/vscode/suite.cjs`, the packed extension): completion before an attribute in `Counter.ucf`'s template lists `@click` (tsserver through the extension's relay), and with the TypeScript extension disabled still lists `v-if` (the relay answers when the command is missing).
- Status: done

### 4.13 `Card.ucf.vue.ts` for `.ts` importers

- Build: in the TypeScript plugin, `.ucf` imports that `resolveTarget()` sends to `vue` resolve to `Card.ucf.vue.ts`, the `types()` file of 4.3, which tsserver serves since 4.3. It exports a Vue `DefineComponent`.
  - `resolveUcfImport` resolves a pick of any served target (`isServedTarget()` in `targetScripts.ts`: a kind with `serviceScript`) to `targetScriptName()`, from every importer. No block for it: `missing-target-block`, unresolved. Svelte picks keep `target-not-built` until M5.
  - A target script in a program brings its `.ucf` file in as a script name too, so an edit of `Card.ucf` marks a project that only picks vue from it dirty. A program that reached such a file first makes the project dirty once more (`afterUpdate()`, from the plugin's `getExternalFiles`, which tsserver calls after each program), because tsserver builds the next program only for a dirty project.
  - Definitions and references that land in `Card.ucf.vue.ts` map into `Card.ucf` through that target's Volar language, from any file. An unmapped definition in another file than the one asked about is that `.ucf` file at its start, as Volar does for a `.vue` file.
  - Global types: `Card.ucf.vue.ts` references `<typesRoot>/template-helpers.d.ts` and `props-fallback.d.ts`. `typesRoot` defaults to the `types/` folder of the installed `@vue/language-core`, which works unbundled. `scripts/lib/bundle-vscode.mjs` copies `@vue/language-core/types/*.d.ts` to `dist/vue-types/` beside the bundle, and the extension's plugin entry is `createTypeScriptPlugin({vueTypesRoot})` (new named export of `@multifront/language-tools/typescript-plugin`; `EditorOptions.vueTypesRoot`) pointing at that copy. Without it, every `__VLS_*` helper type is missing and nothing shows it: those errors sit in unmapped generated code.
  - `fixtures/apps/demo/tsconfig.json` (`module: preserve`, for the attribute in `mountVue.ts`). The imports set gains the `vue-default/` sub-project (plugin option and `multifront()` option `framework: 'vue'`, a bare `.ts` import) and its row.
- Deliverable: a `.ts` file that picks Vue for a `.ucf` import gets the real Vue component type.
- Test: `packages/e2e/editor/vue-types.spec.ts`. Use `startTsserver()` with our plugin on `fixtures/apps/demo/`:
  - in `mountVue.ts`, nothing reported as written; quick info on the import itself reads `import Counter` (language-core exports an expression), a binding of `Counter` is a `DefineComponent` and its `start` prop `number`;
  - `h(Counter, {start: 'x'})` is one `TS2769`, at `start`;
  - with the plugin option `framework: 'vue'` (`imports/vue-default/bare.ts`), a bare import in a `.ts` file resolves the same way, and so do the imports rows the importer's extension picks (`custom-importers/view.tsx`, `no-default/importer.mts`, `no-default/attribute-over-importer.tsx`);
  - a React importer of the same file (`App.tsx`) still gets the React type;
  - definition on `Counter` in `mountVue.ts` lands in `Counter.ucf`, and on `start` in `h(Counter, {start: 1})` on its declaration there; rename of that `start` edits `mountVue.ts` and `Counter.ucf` only;
  - in a fresh tsserver with `bare.ts` opened using `Card`, an unsaved edit of `Card.ucf`'s prop type changes its diagnostics;
  - `projectInfo` with `needFileNameList` lists `template-helpers.d.ts` and `props-fallback.d.ts` from the installed language-core; `getTypesScript()` with a `vueTypesRoot` references them there, and without one the installed ones again;
  - the plugin bundled by `pnpm devx vsix`, in `bundle.spec.ts`'s "plugin pack alone" tsserver (its one pack): a vue pick gets a `DefineComponent`, and `projectInfo` lists the two files from the copy beside the bundle;
  - `packages/e2e/editor/vsix.spec.ts`'s exact list of packed files gains the copied `dist/vue-types/*.d.ts`.

  Also: `vue-block.spec.ts` checks, before any edit, that a `.ucf` file a project reaches only through an import has its Vue script in the program (`afterUpdate()`); the imports rows that pick vue from a `.ts`, `.tsx` or `.mts` importer resolve with no error and their definition lands on `Card.ucf` (`editor/imports.spec.ts`); `mixed.ts`'s vue import has no error now, only the react one's `mixed-frameworks` warning (`tsserver.spec.ts`, `bundle.spec.ts`).
- Status: done

### 4.14 `.vue` importers beside Vue's TypeScript plugin

- Build: how VS Code loads both plugins, and what we change.
  - Vue - Official ("hybrid mode") contributes `@vue/typescript-plugin` through `contributes.typescriptServerPlugins`. VS Code's TypeScript extension then starts tsserver with `--globalPlugins` and `--pluginProbeLocations` for each extension folder.
  - Our extension does the same for our plugin (M2). Both decorate the same language service host. Vue's plugin turns `App.vue` into TypeScript. Its imports, `./Counter.ucf` included, go through the host's `resolveModuleNameLiterals`, which ours wraps. The importer is `App.vue`, so `resolveTarget()` picks `vue`.
  - What we fixed (`packages/language-tools/src/typescriptPlugin.ts`, new `src/languageServicePlugin.ts`):
    - **Load order.** Volar's host wrapper resolves a whole batch itself as soon as one specifier has its plugin's extension. So with ours loaded first, Vue's wrapper took every import of `App.vue`, `.ucf` ones included (`TS2307`). Our `.ucf` resolver now stays outermost: the host's `resolveModuleNameLiterals` is an accessor, and a plugin that wraps it later gets ours on top again.
    - **One shared `@volar/typescript` copy** (a project listing both plugins in `compilerOptions.plugins` from one install, as other editors do, or VS Code with the project's own entry). Volar decorates a host once per module copy, so the plugin loaded second never ran. It also caches each diagnostic's transform by object, so a diagnostic one proxy left as is came out of the other untransformed. `createLanguageServicePlugin()` in `languageServicePlugin.ts` is our copy of Volar's quickstart: it keeps its decoration record and external files per plugin (across tsserver's factory calls on a reload), and `freshDiagnostics()` hands every diagnostic in and out of our proxies as a new object. The VS Code pack still ships its own bundled copy; the npm entry needs no bundle.
    - Our wrapper passes every non-`.ucf` specifier through untouched.
  - `packages/vscode/README.md` (packed in the `.vsix`) says `.vue` importers need Vue - Official installed.
  - `apps/vue/tsconfig.json` (new): `module: preserve`, for the `with { framework: 'vue' }` import in `App.vue` (4.10), else `TS2823`.
  - `@vue/typescript-plugin` 3.3.11 is a root devDependency; `editor/lib/tsserver.ts` exports `VUE_PLUGIN` and `VUE_PLUGIN_DIR` (its install folder), and `startTsserver()` passes its probe locations even with no global plugins, for `compilerOptions.plugins` entries.
- Deliverable: in a `.vue` file, an imported `.ucf` component has its Vue type, with both extensions installed in either order, and with both plugins listed in `tsconfig.json` from one install.
- Test: `packages/e2e/editor/vue-importer.spec.ts`, four tsserver setups: the VS Code way (`@vue/typescript-plugin` from its own install folder, ours from the packed `.vsix`, as global plugins) in both orders, and `tsconfig.json` `compilerOptions.plugins` (Vue's and the project's own `@multifront/language-tools/typescript-plugin`, both from the project's `node_modules`, one shared `@volar/typescript`, checked) in both orders. In each, on a copy of `fixtures/apps/vue/`, opening `src/App.vue`:
  - each plugin loaded from the expected folder (the tsserver log); `App.vue` as written has no diagnostic;
  - `<Counter :start="'x'" />` gives exactly one `TS2322`, at `start`;
  - quick info on `<Counter` is the Vue `DefineComponent`;
  - go to definition on `<Counter` lands on `Counter.ucf` at 1:1 (as Volar does for a `.vue` component), and on `:start` on its `start?: number` declaration in the `<vue>` block of `Counter.ucf`;
  - `Counter.ucf`'s own `<vue>` block still reports `{{ count.toFixed('x') }}` at the `.ucf` range of `'x'`;
  - a plain `.vue` import in the same file keeps working (definition on `<Plain` lands in `Plain.vue`);
  - after `reloadProjects` (tsserver calls each plugin factory again), a `.ucf` file added under `src/` joins the project and its errors and definitions map as before.

  Also: `editor/imports.spec.ts` runs every row with our plugin alone and again beside Vue's plugin, so the `src/Page.vue` row runs (no error, definition on `Card.ucf`); `vsix.spec.ts`'s exact packed list gains `README.md`.
- Status: done

## Hands to later milestones

- `vueSfcCode(source, blocks, filename)` in `@multifront/core`: the same-length SFC code with a map. Used by **M7** (`mf-lint` / `mf-fmt` run on the `<vue>` block with positions 1:1, and `mf-tsc`).
- `vueKind` and `vueEditorKind`, the `<vue>` row in both registries (`check`, `build`, `grammar`, `editor`, `types`, `serviceScript`), and the diagnostic code `vue-empty-block`; its `check` also reports `framework-in-block` in the block's scripts. Used by **M6** (the Vue library build and its `.d.ts` from `Card.ucf.vue.ts`) and **M7** (`mf-tsc` checks the Vue target of every file).
- `packages/vite/src/vueTarget.ts`: plugin-vue composition (`include`, the exclude pattern `/\.ucf\?(?:.*&)?ucf\b/`, `componentIdGenerator`, cache warm-up, `wrapVueCompiler()` giving sub-request maps the `.ucf` text; `cssModules.ts` beside it sets `css.modules.generateScopedName`), and the `multifront:vue-hmr` plugin; `multifront:vue-importers` in `attributes.ts` beside it. Used by **M6** (`multifront({framework: 'vue'})` plus `vue()` builds the Vue package unchanged) and **M5** (`Card.ucf.svelte.svelte` ids never match the include, so the Svelte target needs no change here).
- The way 4.3 serves a second target script of a `.ucf` file in tsserver, beside the React one: `packages/language-tools/src/targetScripts.ts` serves every editor kind with a `serviceScript` as `targetScriptName(file, tag)`. Used by **M5** (`Card.ucf.svelte.ts`, 5.10: `svelteEditorKind` gains `serviceScript`).
- Our TypeScript plugin beside another tsserver plugin on the same host (4.14): the `.ucf` resolver stays outermost in any load order, and `createLanguageServicePlugin()` (`packages/language-tools/src/languageServicePlugin.ts`) keeps its decoration record, external files and diagnostic objects its own. Used by **M5** (`typescript-svelte-plugin` beside ours, 6.11).
- `Card.ucf.vue.ts` through the TypeScript plugin, for `.ts` and `.vue` importers. Used by **M6** (Vue `.d.ts`) and **M7** (`mf-tsc` must also cover `.vue` importers, because `vue-tsc` does not load tsserver plugins).
- Fixtures: the `<vue>` blocks of the shared `Counter.ucf`, `imports/Icon.ucf` and `imports/UsesIcon.ucf`; `imports/ReactOnly.ucf`; `packages/e2e/fixtures/components/vue/` (`CounterCrlf.ucf`, `VBind.ucf`, `DuplicateVue.ucf`, `Empty.ucf`, `StyleOnlyInVue.ucf`, `VueWithUnclosedReact.ucf`, `TemplateError.ucf`, `AttrInside.ucf`, `AttrInsideJs.ucf`, `ComposesFile.ucf`, `GlobalProps.ucf`); the app `packages/e2e/fixtures/apps/vue/` with SSR entries, and the demo app with a Vue island. Used by **M6** (base of the fresh Vite Vue consumer app) and **M5** (adds Svelte to the demo).
- `expectSameComputedStyles()` in `packages/e2e/browser/lib/parity.ts` and `packages/e2e/browser/parity.spec.ts`. Used by **M5** (adds the Svelte counter to the same parity test).

## Exit test

`packages/e2e/browser/vue-exit.spec.ts`, on the demo app (`fixtures/apps/demo/`) plus `fixtures/apps/vue/`:

1. A production build of the demo renders `Counter.ucf` as React and as Vue in Playwright, with the same `data-v-*` and the same computed styles.
2. The Vue app's SSR build renders the Counter on the server and hydrates with no mismatch warning.
3. A fresh dev server process answers the Vue style sub-request as its first request, and a `<template>` edit hot-updates without losing state.
4. `startTsserver()` with Vue's plugin and ours reports the wrong prop type on `<Counter>` in `App.vue`.

## Risks and open questions

- **plugin-vue behavior we rely on that is not formal API:** the HMR `read` override, its `_rerender_only` export and `__VUE_HMR_RUNTIME__.CHANGED_FILE` (4.9), the cache-miss read from disk, the hook-filter `exclude` and the moment `api.include` locks. Every one is covered by a test in 4.4, 4.7 or 4.9, run on the CI matrix of supported plugin-vue versions. Worth proposing upstream: a plugin-vue option that hands it the SFC code of non-`.vue` files. That would remove the warm-up and the `read` override. Also worth proposing: a previous descriptor for non-`.vue` files, so plugin-vue writes `_rerender_only` itself.
- **Vite's `vite:css` transform hook is wrapped**, not formal API: it runs a `.ucf` style sub-request inside the `AsyncLocalStorage` that names composed classes, and lightningcss reads its per-block pattern from a getter on `css.lightningcss` (4.5). If Vite renames the plugin or its hook loses `handler`, the plugin throws at `configResolved`; the 4.5 test fails first if the context stops reaching postcss-modules.
- **`handleHotUpdate` is on its way out** in Vite in favor of `hotUpdate`. When plugin-vue moves, our override must move with it, because the two hooks get different context objects. The 4.9 test fails first.
- **CSS twice in a mixed app** (decided: accepted for now, spec 4.3). The Vue target uses plugin-vue's own style modules, React and Svelte use ours, so an app importing one file as Vue and as another framework ships identical rules twice. A later dedupe can answer plugin-vue's style request with the shared module.
- **Two Volar TypeScript plugins in one tsserver** (settled in 4.14). Load order and a shared `@volar/typescript` copy both broke `.vue` importers; 4.14 fixed both and tests each setup. `src/languageServicePlugin.ts` mirrors Volar's quickstart internals (`createProxyLanguageService`, `createLanguageCommon`, `searchExternalFiles`, the per-object diagnostic transform cache), so a Volar bump is what breaks it first; the 4.14 test fails first.
- **Version skew in the editor (settled by spike 2).** Our pinned `@vue/language-core` may differ from the one inside the user's Vue extension. That does not matter for `.ucf` files: the generated code and its global types (`template-helpers.d.ts`, `props-fallback.d.ts`) both come from our own copy, which the bundle ships (4.13).
- **Vue services on a forwarding root.** Vue's service plugins read `ir`, `fileName` and `vueCompilerOptions` from the root code, not from the code they serve. Our root forwards them, so it relies on non-formal API. The 4.12 test fails first if a language-core release moves them.
- **Two `instanceof VueVirtualCode` checks stay off** (decided: accepted for M4). First, tag and attribute name casing in completions follows the casing setting (`vue.complete.casing.*`) instead of being detected from the file. The setting still works, only the guess from the file is lost. Second, Vue's `vue.format.*.initialIndent` options do not apply. That loses nothing: `.ucf` files are formatted by M7's `mf-fmt` through oxfmt, which writes block text flush left (7.6), not by Vue's formatter.
- **Who resolves the bare `.ucf` id for `vue`**, M3 or this milestone. Listed under "Needs", with 4.4 as the fallback.
- **Dependency pre-bundling** (settled in 4.4): the scan follows `<vue>` blocks the way M3 does for `<react>`, so a dependency first seen in a `<vue>` block is optimized at startup, with no late re-bundle.
- **Same-length blanking** must keep every `\r`, `\n` and UTF-16 position. `CounterCrlf.ucf` and a non-ASCII string in `Counter.ucf` guard it.

## Out of scope

- The Vue library build, its `.d.ts` and its consumer app (M6).
- `mf-tsc`, `mf-lint`, `mf-fmt` for `<vue>` blocks (M7), and the `vue-tsc` view of `.vue` importers (M7).
- `v-bind()` in CSS for the React or Svelte targets (spec section 12).
- A `<style>` inside the `<vue>` block (stays the `style-inside-target` error).
- Vue custom elements (`.ce`), Vapor mode, Nuxt, and Vue custom blocks inside `<vue>` (they pass through to plugin-vue, but are not tested).
- Other editors than VS Code (only their tsserver setup is covered, by 4.14).

## Manual QA

Run from the repo root. Commands that start Vite load `@multifront/vite` from `src/` with `NODE_OPTIONS=--conditions=source` and `--configLoader native`. Marks: **pass**, **fail** (with its issue), **needs a person**.

1. `pnpm devx test packages/e2e/browser/vue-exit.spec.ts`: 4 tests pass (the exit test, items 1 to 4). **pass** (missing on `main`: #81; the QA PR adds it)
2. `pnpm devx check` with the QA tests: green, 65 test files and 2390 tests run, none skipped. **pass**
3. `pnpm devx test packages/e2e/build/vue-compose.spec.ts -t "library build"`: 2 tests pass; `Counter.ucf` as a library entry with `multifront({framework: 'vue'})` and `vue()` compiles its `<vue>` block with our scope id and `$style` names, and `ReactOnly.ucf` fails naming the file (the seam M6's Vue package builds on). **pass**
4. `NODE_OPTIONS=--conditions=source pnpm exec vite build packages/e2e/fixtures/apps/vue --configLoader native --outDir /tmp/mf-vue --emptyOutDir`, then `grep -rlE "framework|useState" /tmp/mf-vue`: the build succeeds, grep prints nothing, and the CSS holds `.counter[data-v-a5afa5a3]`. **pass**
5. The same build of `packages/e2e/fixtures/apps/demo` to `/tmp/mf-demo`, then `grep -rl framework /tmp/mf-demo`: nothing, and the CSS holds the same `.counter[data-v-a5afa5a3]` as the Vue app. **pass**
6. `cd packages/e2e/fixtures/apps/vue && NODE_ENV=development node --conditions=source server.ts`, then `curl -s` the URL it prints: the HTML holds `<div class="counter" data-v-c4f952ac>` and `<button class="button_c4f952ac_1" …>2</button>`, rendered on the server. **pass**
7. `NODE_OPTIONS=--conditions=source pnpm exec vite packages/e2e/fixtures/apps/vue --configLoader native --port 5191`, then `curl -s localhost:5191/src/App.vue | grep -c "with {"`: `0`, and the three `.ucf` imports are `/@fs/…/*.ucf?import` URLs. **pass**
8. Same server, open the URL: Counter shows 2 in purple. Click to 3, change "Clicks" in the `<vue>` template of `packages/e2e/fixtures/components/Counter.ucf`, then the scoped `rgb(120, 40, 160)`, then "Clicks" in the `<react>` block: the first two show at once with the count still 3 and no page reload, the third changes nothing. In devtools Sources, `Counter.ucf` shows the whole file, `<react>` block included. Undo with `git checkout packages/e2e/fixtures/components/Counter.ucf`. **needs a person**
9. `NODE_OPTIONS=--conditions=source pnpm exec vite packages/e2e/fixtures/apps/demo --configLoader native`, open the URL: the React and the Vue counter look the same, and each counts its own clicks. **needs a person**
10. `pnpm devx vsix`, install the `.vsix` and Vue - Official in VS Code, open `packages/e2e/fixtures/apps/vue/`. In `Counter.ucf`: hover on `count` in `{{ count }}` shows its `Ref` type, `$style.buton` is red, completion after `<span ` lists `v-if` and `@click`. In `src/App.vue`: `<Counter :start="'x'" />` is red at `start`, and go to definition on `<Counter` opens `Counter.ucf`. **needs a person**
