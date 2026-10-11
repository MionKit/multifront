---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.13
---

# Milestone 4.13: `Card.ucf.vue.ts` for `.ts` importers

## Problem

Since 4.3, tsserver serves `Card.ucf.vue.ts` beside the React script (`targetScripts.ts`), and since 4.12 a `<vue>`
block's own `.ucf` imports resolve to it. Every other vue pick still fails:

- `resolveUcfImport` (`packages/language-tools/src/resolve.ts:109`) resolves a vue pick only when
  `importer.block === 'vue'`. A `.ts` importer (`with {framework: 'vue'}`, plugin option `framework: 'vue'`,
  `importers`) falls to line 114: `target-not-built`, unresolved. So `mountVue.ts` in the demo gets no type for `Counter`.
- Navigation from a `.ts` file into `Card.ucf.vue.ts` would be lost: `intoUcf` (`targetScripts.ts:64`) drops every
  location in a target script. Before this step only `.ucf` requests reached those, already mapped by the target proxy.
  A `.ts` request goes through Volar's main proxy, which does not know `Card.ucf.vue.ts`, so even mapped spots are
  dropped.
- A `.ucf` file reached only through a vue pick is not a program file (`getScriptFileNames`, `targetScripts.ts:166`,
  adds target scripts only for `.ucf` files the program already holds). Its ScriptInfo is attached to no project of the
  importer, so an unsaved edit of `Card.ucf` never marks that project dirty: the importer keeps the old props.
- Global types. Language-core's script starts with `/// <reference types="<rel>/template-helpers.d.ts" />` and
  `props-fallback.d.ts` (`vue-3.4-shims.d.ts` when Vue < 3.5), relative to `typesRoot`
  (`@vue/language-core/lib/codegen/script/index.js:173`). `typesRoot` defaults to
  `posix.join(__dirname, '..', 'types')` (`lib/compilerOptions.js:189`). In `packages/vscode/dist/typescript-plugin.cjs`
  `__dirname` is `dist/`, so the reference points at the missing `packages/vscode/types/`. Every `__VLS_*` helper is
  then missing, and nothing shows it.

## Decisions

- Orchestrator: plan approved.
- Q1, orchestrator: map target-script locations into the `.ucf` file for every navigation request (step 3). Step 2
  stays: both are gaps this step's resolution creates.
- Q2, orchestrator: the `framework: 'vue'` check is a `vue-default/` sub-project of the imports set, with an
  `expected.ts` row.
- Q3, orchestrator: first "keep the bundled check in `vue-types.spec.ts`", then reversed after review: it moved into
  `bundle.spec.ts`'s "plugin pack alone" describe, which reuses its one pack, with a `DefineComponent` check there too.
- Review: `TypeScriptPluginOptions` stays private to `typescriptPlugin.ts`; the default export is `/* @__PURE__ */`
  so the bundle drops it. Copying the types to where language-core's default looks was declined (Q4: the step's Build
  line asks the bundled plugin to set `typesRoot`).
- Q4, orchestrator: the bundle sets `typesRoot` through an explicit `createTypeScriptPlugin({vueTypesRoot})`.
- No fuzz test: no cheap oracle.

## Plan

### 1. Resolution (`packages/language-tools/src/resolve.ts`)

- A pick of a target that `targetScripts.ts` serves (an editor kind with `serviceScript`; today `vue`) resolves to
  `targetScriptName(fileName, target)` (`extension: ts.Extension.Ts`) from every importer.
- Target file without that block: `missing-target-block`, unresolved.
- `svelte` keeps `target-not-built` until M6.
- `targetScripts.ts` exports `isServedTarget(target)`.

### 2. The `.ucf` file joins the importer's program (`targetScripts.ts`, `getScriptFileNames`)

- Every target script the last program reached brings its `.ucf` file as a script file name too (`addedScriptNames`).
  tsserver then attaches the `.ucf` ScriptInfo to the project, so an edit of `Card.ucf` marks a project with only a vue
  pick of it dirty.
- Found while building: tsserver builds the next program only for a dirty project, so a file the program reached first
  never made it in until some other edit. `afterUpdate()` (from the plugin's `getExternalFiles`, which tsserver calls
  after every program) marks the project dirty once when a script name we add is not in the program yet. This also
  covers 4.3's target script of a `.ucf` file first reached through an import.

### 3. Locations in a target script map into the `.ucf` file (`targetScripts.ts`, `intoUcf`)

- For every `NAVIGATION` result, from any file: a location in `Card.ucf.<tag>.ts` goes through that served target's
  language with Volar's `transformDocumentSpan`, with the matching `@volar/language-core` filter.
- Unmapped: a definition in another file than the one asked about goes to the `.ucf` file at 0:0, as Volar does for a
  `.vue` import. One in the asked file's own script is generated code, dropped. Every other unmapped location is
  dropped, as before; a referenced symbol's definition still falls back to the `.ucf` file.
- Highlight groups keep 4.3's handling (only a `.ucf` request searches a target script, and Volar has mapped those).

### 4. `typesRoot` for the bundle

- `EditorOptions` gains `vueTypesRoot?: string`; `vuePlugin()` sets `typesRoot` from it, cached per compiler options
  and root. Unset: the installed `@vue/language-core`'s own.
- `src/typescriptPlugin.ts` exports `createTypeScriptPlugin(options?: {vueTypesRoot?: string})`. The default export is
  `createTypeScriptPlugin()`. The "first copy serves" owner check compares a module-level token.
- `packages/vscode/src/typescriptPlugin.ts`: `createTypeScriptPlugin({vueTypesRoot: join(import.meta.dirname,
  'vue-types')})`; the CJS bundle writes `__dirname`.
- `scripts/lib/bundle-vscode.mjs` copies every `*.d.ts` of language-core's `types/` into
  `packages/vscode/dist/vue-types/`.
- The language server bundle keeps the default: it never type-checks.

### 5. Fixtures

- `packages/e2e/fixtures/apps/demo/tsconfig.json` (new): `module preserve`, `moduleResolution bundler`,
  `jsx react-jsx`, `allowImportingTsExtensions`, `strict`, `noEmit`, `skipLibCheck`, `include: ["src"]`.
- `fixtures/apps/imports/vue-default/`: `tsconfig.json` (plugin entry `framework: 'vue'`), `vite.config.ts`
  (`multifront({framework: 'vue'})`), `bare.ts` (a bare import of `Card.ucf`). New row in `expected.ts`.

## Tests

All in `pnpm devx test`, on this host and in CI's `check` and `vue-floor` jobs. No new infra.

`packages/e2e/editor/vue-types.spec.ts` (new):

- demo, `mountVue.ts`: no diagnostic as written. A binding of `Counter` is `const counter: DefineComponent<…>`, and
  `start` in `h(Counter, {start: 1})` is `start?: number | undefined`. Quick info on the import itself reads
  `import Counter`: language-core exports an expression, `{} as typeof __VLS_export`.
- demo: an unsaved `h(Counter, {start: 'x'})` gives exactly one `TS2769`, at `start`.
- demo, `App.tsx`: `Counter` still has the React type.
- demo: definition on `Counter` in `mountVue.ts` is `Counter.ucf` at 1:1.
- Definition on `start` in `h(Counter, {start: 1})` lands on `start?: number` in `Counter.ucf`; rename of it edits
  `mountVue.ts` and `Counter.ucf` only (`props.start` and the declaration).
- `imports/vue-default/bare.ts`, `custom-importers/view.tsx`, `no-default/importer.mts`,
  `no-default/attribute-over-importer.tsx`: a binding of the import is a `DefineComponent`.
- `getTypesScript()` with a `vueTypesRoot` references the global types there, and without one (same compiler
  options, same module copy) the installed ones: the plugin cache is per root.
- A fresh tsserver with `bare.ts` opened using `h(Card, {title: 1})`: one `TS2769`, none after an unsaved edit of
  `Card.ucf`'s prop to `title: number`. Fails without `afterUpdate()`.
- `projectInfo` lists `template-helpers.d.ts` and `props-fallback.d.ts` from the installed language-core.

`bundle.spec.ts`, "plugin pack alone": a vue pick (`no-default/attribute-over-importer.tsx`) gets a
`DefineComponent`, and `projectInfo` lists the two files from `dist/vue-types/`, none from language-core.

`vue-block.spec.ts`: before any edit, a `.ucf` file a project reaches only through an import has its Vue script in
the program (fails without `afterUpdate()`).

`vsix.spec.ts`: the exact packed list gains `dist/vue-types/*.d.ts`. `LANGUAGE_CORE_TYPES` in `editor/lib/vsix.ts`.

Updated: `imports.spec.ts` vue rows resolve with no error and definition on `Card.ucf`; `mixed.ts` cases in
`tsserver.spec.ts` and `bundle.spec.ts` lose their `target-not-built`. The core rewrite snapshot of the new
`vue-default/bare.ts` is added.

## Docs

- `docs/milestones/m4-vue-target.md` 4.13: what shipped, `- Status: done`.
- `docs/architecture.md`, "Editor and types": "Importing a `.ucf` file" and "Packaging".
- `docs/plan.md`, "Prototype first", item 2, answer 4.
- `publicdocs/04-imports.md` and `publicdocs/07-errors.md`: only svelte picks give `target-not-built` in the editor.

## Fuzzing

None: no cheap oracle.

## Out of scope

- 4.14: `.vue` importers beside Vue's TypeScript plugin.
- Svelte picks (M6). `mf-tsc` (M7).
- A diagnostic's related information that points into `Card.ucf.vue.ts`.
- `typesRoot` in the language server bundle.

## Done when

- A `.ts` importer's vue pick resolves to `Card.ucf.vue.ts` and gets the real `DefineComponent`, from source and from
  the `.vsix` bundle with its own copy of language-core's global types.
- Every test above passes. `pnpm devx check` is green. Docs updated. 4.13 ends with `- Status: done`.
- This todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
