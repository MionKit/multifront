---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.9
---

# Milestone 5.9: Types: `Card.ucf.svelte.ts`

## Problem

A `.ts` file that picks svelte for a `.ucf` import gets `target-not-built` (`packages/language-tools/src/resolve.ts:114-122`); the `<svelte>` editor row is a bare tag (`packages/language-tools/src/blocks/svelte.ts`). Imports inside a `<svelte>` block never reach tsserver. Milestones 2 and 3 say M5 deletes `target-not-built`, in the editor and the build alike.

## Plan

### Core: share the `$style` rename, no stamps (`packages/core`)

- `src/types.ts:111`: `SvelteCompiler = Pick<typeof SvelteCompilerModule, 'parse' | 'VERSION'>` (svelte2tsx takes the version).
- `src/blocks/svelte.ts`: `ownModule` (81), `classMap` (86), `styleUses` (98) read `split` + a `modules: Record<string, Module>` instead of the whole `BuildContext` (generic over the module object). `localNames` (158) and `build()`'s rename loop (208) become one helper both paths call; `build()` output is unchanged.
- New export `renameSvelteStyles(block, split, compiler, modules)` → `{code, locals, lang}`: the block content with every class map use renamed exactly as `build()` does (`$style` → `__ucfStyle`, shorthands kept), no stamps, imports or forwarding; `locals` = module → local name used; `lang` `'ts' | 'js'` by Svelte's rule (the first script `lang`, `topLevelTags` as `frameworkInBlock` reads it; only `ts` is TypeScript, as Svelte's parser). Parses with `{modern: true, loose: true}`: a block Svelte cannot parse (a `CompileError`) gives its content unrenamed, `locals` empty; any other error is rethrown, as `parseBlock` does. No source map until 5.10 reads one.
- `src/types.ts:79`: `'target-not-built'` leaves `DiagnosticCode` (nothing in core, Vite or the editor names it any more).

### Editor half: `packages/language-tools/src/blocks/svelte.ts`

- `types(block, ctx)` (undefined without `ctx.svelteCompiler`): `renameSvelteStyles(block, ctx.split, ctx.svelteCompiler, ctx.modules)`, then `svelte2tsx(code, {filename: `${filename}.svelte.svelte`, isTsFile: lang === 'ts', mode: 'ts', parse, version, emitOnTemplateError: true})` with the project's `parse` / `VERSION` (the `.svelte.svelte` name is the spec 4.3 id, giving `Panel__SvelteComponent_`). svelte2tsx still throwing a Svelte `CompileError` → no script; anything else is rethrown. Prepended: `/// <reference path="<svelteTypesRoot>/svelte-shims-v4.d.ts" />` and `svelte-jsx-v4.d.ts`. Appended: `declare const __ucfStyle: {readonly title: string};` per `locals` entry, the type text and the navigation-only key mappings moved from `blocks/react.ts` into a shared helper both rows call (React output unchanged; loose `{readonly [name: string]: string}` for an unreadable module). Returns `{ext: '.ts', code, map: undefined, mappings}`; the only mappings are those key ones (the source-map-to-Volar converter is 5.10).
- `svelteTypesRoot` default: the installed `svelte2tsx` folder (as `vueTypesRoot`).
- `editor()` returns that script as a Volar code, `languageId` `typescript` / `javascript` by `lang`; `serviceScript(code)` returns it with ScriptKind TS / JS. That makes `svelte` a served kind (`isServedTarget`): tsserver serves `Card.ucf.svelte.ts` beside the React and Vue scripts, and an import inside the block resolves from importer `Card.ucf.svelte.ts` (block rule, `importerFromId` already knows the suffix).
- `src/types.ts` `EditorOptions` gains `svelteCompiler?: SvelteCompiler` (without it, no `<svelte>` code) and `svelteTypesRoot?: string`.
- `package.json`: dependency `svelte2tsx: 0.7.61` (published 2026-08-13), optional peer `svelte: ^5.55.6`, devDependency `svelte: 5.57.0` (packages/AGENTS.md peer rule).

### TypeScript plugin (`src/typescriptPlugin.ts`, `src/resolve.ts`)

- `projectCompiler(info, load, without)` (70) now loads either compiler: `loadSvelteCompiler(project dir)` failing → logs `multifront: no Svelte compiler, svelte picks have no types (<reason>)`, `undefined`. Line 136 passes `svelteCompiler` and `svelteTypesRoot`; `TypeScriptPluginOptions` (85) gains `svelteTypesRoot`.
- `resolve.ts:114-122`: the `target-not-built` branch and `RULE_REASON` go: every target is served. Core's `importPath` loses its last outside reader and stops being exported.
- Missing Svelte: no compiler → no script → the pick is TypeScript's own `TS2307` at the specifier (checked with the TS API: a resolved name with no file gives exactly that), plus the log line. No new code.
- No resolution change for the shims (planned, dropped while building): their `import('svelte')` / `import('svelte/elements')` already resolve beside the VS Code bundle, because Svelte's types declare `module 'svelte'` globally and every script references them (`///<reference types="svelte" />`). The bundle test proves it.
- `targetScripts.ts` `spansIntoUcf`: a definition that falls back to the same spot of a `.ucf` file comes back once. svelte2tsx declares the component as a value and a type, so definition on `Panel` gave `Panel.ucf` twice (found by the definition test).

### VS Code pack (needed: else the pack breaks)

svelte2tsx imports `typescript` and `svelte/compiler` at load; the pack runs from the extension folder, which ships no `typescript`, and the server bundle pulls it in too.

- `scripts/lib/bundle-vscode.mjs`: for imports from svelte2tsx only, `typescript` → a proxy module over the TypeScript module tsserver hands our plugin, and `svelte/compiler` → a stub (we always pass `parse` and `version`). Copy `svelte-shims-v4.d.ts` and `svelte-jsx-v4.d.ts` to `dist/svelte-types/`.
- `packages/vscode/src/typescriptPlugin.ts`: stores `modules.typescript` (under `Symbol.for('multifront.host-typescript')`) before the plugin factory runs; `svelteTypesRoot: join(import.meta.dirname, 'svelte-types')`. As built: the proxy is the default export of `packages/vscode/src/bundle/hostTypeScript.ts` (svelte2tsx's `index.mjs` imports it as a default) and the stub `bundle/noSvelteCompiler.ts`; `typescript` stays external for every other importer. Without the proxy every pack test fails (checked).

### Fixtures

- `fixtures/apps/svelte-vite/tsconfig.json` (new): the demo app's options (`module: preserve` for `with {framework}`, strict, `skipLibCheck`). 5.11 adds `rootDirs` to it.

## Tests

All on this host and in CI (`check` job, `pnpm devx test`; tsserver is a child process, no new infra); `svelte-floor` reruns them on svelte 5.55.6.

- **`packages/e2e/editor/svelte-types.spec.ts`** (new), real tsserver with our plugin on `apps/svelte-vite`, opening `src/main.ts` (imports `Panel.ucf` and `Counter.ucf` with `framework: 'svelte'`):
  - `main.ts` as written has no diagnostic;
  - a binding of `Panel` reads `Component<…>`; `ComponentProps<typeof Panel>['heading']` is `string`, Counter's `start` `number | undefined`;
  - `mount(Panel, {target, props: {heading: 1}})` is exactly one `TS2322`, at `heading`;
  - definition on `Panel` lands in `Panel.ucf`;
  - in-block rule, in tsserver: an unsaved edit of `Panel.ucf`'s `<svelte>` block typing `heading` as `typeof PanelItem` makes `ComponentProps<typeof Panel>['heading']` in `main.ts` a Svelte `Component<…>` (not React's function);
  - in-block rule, through public functions: `resolveUcfImport` over `getTypesScript(Panel, 'svelte')`'s code as `Panel.ucf.svelte.ts` resolves `./PanelItem.ucf` to `PanelItem.ucf.svelte.ts`, no error;
  - `getTypesScript(…, 'svelte', {svelteCompiler})`: Panel's code holds `__ucfStyle.title`, no `$style`, and `declare const __ucfStyle: {readonly title: string};`; references the shims in the installed svelte2tsx (the `svelteTypesRoot` copy is checked from the pack in `bundle.spec.ts`); `undefined` without `svelteCompiler`; a script error (`svelte/errors/ImportParseError.ucf`) still gives a script, unrenamed, and markup svelte2tsx cannot read (`UnclosedBrace.ucf`) none; the `svelte` code of `createUcfLanguagePlugin({svelteCompiler})` is that script, served as TS for Panel and as JavaScript for the lang-less `svelte/NoStyle.ucf`.
- **The shared resolution set: build and tsserver pick the same target for each Svelte row.**
  - **The Svelte rows** are the four existing rows of `fixtures/apps/imports/expected.ts` expecting `svelte` (all there since M2 and M3); no new row in this step:
    - `src/lazy.ts` (attribute, dynamic `import()`);
    - `src/attribute-over-importer.tsx` (attribute over the importer's extension);
    - `custom-importers/widget.ts` (importer extension, `importers: {'.ts': 'svelte'}`);
    - `src/Gallery.svelte` (importer extension `.svelte`).
  - No new row: an in-block `<svelte>` row (a `.ucf` whose `<svelte>` block imports `Card.ucf`) is checkable in tsserver only at positions inside the block, which need 5.10's mappings; the in-block rule is pinned in `svelte-types.spec.ts` above (Panel → PanelItem, in tsserver and through `resolveUcfImport`). `.svelte` importers are already covered by `src/Gallery.svelte`.
  - **How the two sides are compared:** both specs assert each row against the same `row.expect` in `expected.ts`, the set's one oracle (milestones README: "the build and the editor must both match every row"):
    - **Build side:** `packages/e2e/build/imports.spec.ts` (area build, unchanged; runs every svelte row since 5.4): in real Vite dev servers, client and SSR, each svelte row's import becomes `Card.ucf.svelte.svelte`, no attribute left.
    - **tsserver side:** `packages/e2e/editor/imports.spec.ts` (area editor), both setups (our plugin alone; beside Vue's). Each svelte row except `Gallery.svelte` now gets: no diagnostic on its line; definition on the specifier lands on `Card.ucf`; and **the target itself**: an unsaved edit appends `const picked = <binding>;`, whose quick info must read `Component<…>` (Svelte), not `DefineComponent<` (vue) or React's function. Binding per row: `lazy.ts` → `SvelteCard.default`, `attribute-over-importer.tsx` → `SvelteCard`, `widget.ts` → `Card`. A guard checks this table lists exactly the svelte rows tsserver runs. The `target-not-built` branch goes.
  - **`src/Gallery.svelte` split:** its build side keeps running in `build/imports.spec.ts`; its tsserver side comes in 5.11, which sets up and tests Svelte's own tsserver plugin, the only way tsserver reads a `.svelte` importer. 5.11's Test list in the milestone doc names the row.
- **`editor/tsserver.spec.ts`**, project outside the repo (no svelte there): the default-svelte bare import is exactly one `TS2307` at the specifier; the tsserver log has the "no Svelte compiler" line.
- **`editor/styleClasses.spec.ts:125`**: name and svelte case read "no Svelte compiler" instead of "no types yet".
- **`editor/bundle.spec.ts`**, pack alone: the pack still loads; a svelte pick (`lazy.ts`) gets a `Component<…>`; `projectInfo` lists both shims from `dist/svelte-types/` and `svelte`'s types from the project, no `svelte2tsx` path; the bundled language server cases still pass; the plugin bundle holds svelte2tsx and the proxy, and no TypeScript or Svelte compiler source.
- **`editor/vsix.spec.ts`**: the exact packed list gains `dist/svelte-types/svelte-shims-v4.d.ts` and `svelte-jsx-v4.d.ts`.
- **Core**: the existing `svelte.spec.ts`, `forward.spec.ts` and 5.7 fuzz pin `build()`'s output across the rename refactor.

## Docs

- `docs/milestones/m5-svelte-target.md`: `- Status: done` on 5.9; step text to what shipped (`svelteTypesRoot` and the bundle copy, the missing-Svelte `TS2307`, `renameSvelteStyles`, the served `svelte` script with 5.10 adding mappings, the Gallery split); "Hands to later milestones" to match.
- `target-not-built` deleted → no doc names it (AGENTS.md "A removed thing leaves NO trace"): lines naming it in `m2-editor-basics.md`, `m3-react-and-imports.md`, `m4-vue-target.md` and m5's 5.1 / 5.2 text reworded without the code.
- `publicdocs/04-imports.md`: the note says a svelte pick has types when the project has `svelte` installed. `publicdocs/07-errors.md`: the `target-not-built` row goes.
- `docs/architecture.md:109` (packaging): the `.vsix` also ships `dist/svelte-types/`, and svelte2tsx in the bundles uses the TypeScript tsserver hands the plugin.
- spec, plan: none (spec 226 already describes `Card.ucf.svelte.ts` from svelte2tsx).

## Decisions

From the orchestrator:

- The VS Code pack fix is in this PR (rule 1, AGENTS.md: "Related to the current task → fix it in the same PR, own commit, own test").
- No Svelte installed: TypeScript's own `TS2307` plus a tsserver log line, no new code (rule 2: language-core reports nothing special when `vue` is missing).
- `target-not-built` removed from the m2 to m5 milestone docs (rule 1, AGENTS.md: "A removed thing leaves NO trace … no doc line naming the old name").
- No fuzz test (rule 3: the step does not ask for one).
- The Svelte rows are the four existing ones; `src/Gallery.svelte`'s tsserver side comes in 5.11 (amended Tests).

## Out of scope

- Source-map-to-Volar mappings, hover / errors / completions inside `<svelte>`, `check` diagnostics there: 5.10.
- `.svelte` importers, `emitSvelteTypes`, `rootDirs`: 5.11.
- Keeping the last good types while a block does not parse.
- The language server loading Svelte (it has no TS features in hybrid mode).

## Done when

- A `.ts` svelte pick gets a real `Component` type in tsserver, unbundled and from the `.vsix` pack.
- `target-not-built` is gone from code, tests and docs.
- Every test above passes; `pnpm devx check` is green.
- Milestone doc updated; this spec moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
