---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 4
step: 4.3
---

# Milestone 4.3: the `<vue>` block kind, both halves

## Problem

`<vue>` is half a row of the grid. `vueKind` (`packages/core/src/blocks/vue.ts`) has `check` (`style-inside-target`)
and `grammar`, no `build`. `vueEditorKind` (`packages/language-tools/src/blocks/vue.ts`) is `{tag: 'vue'}`. In
tsserver a `.ucf` file has one script, the React one (`getServiceScript`, `languagePlugin.ts`, `MAIN_SCRIPT_TARGET`):
Volar's tsserver plugin serves no extra scripts (`decorateLanguageServiceHost` only warns "getExtraServiceScripts() is
not available in TS plugin"). In hybrid mode only tsserver gives TypeScript inside `<vue>`, so 4.3 must serve the Vue
`script_ts` beside the React script (4.12 and 4.13 need it). `vueSfcCode()` (4.2) leaves an unclosed block's raw text
in place; the editor is its first caller that reads files with split errors.

tsserver refuses a program file with no ScriptInfo (`ProjectService.setDocument`, `Debug.checkDefined`). Checked
during planning in an in-memory `ts.server.ProjectService`: a ScriptInfo from
`getOrCreateScriptInfoForNormalizedPath(name, false, undefined, kind, /*mixed*/ true, {fileExists: () => true})`,
attached to the project, plus project overrides of `getScriptFileNames`, `getScriptSnapshot`, `getScriptVersion`,
`getScriptKind`, `fileExists`, puts a file that is not on disk in the program, with diagnostics and edits.

## Plan

### 1. Core: `vueKind` gets `vue-empty-block` and `build` (`packages/core/src/blocks/vue.ts`)

- Keep the name `vueKind` (beside `reactKind` and `styleKind`); the step text and Hands say `vueBlock`, they change.
- `check`: `topLevelTags(block.content, isTemplate, notTemplate)`, the raw scan `styleInsideTarget` uses. No top-level
  `template` or `script` → `vue-empty-block` on the opening tag (`block.start..block.contentStart`), message
  `<vue> has no <template> or <script>; add one`. Sorted by `start`. Core still imports no compiler.
- `build: (block, ctx) => ({ext: '.vue', ...vueSfcCode(ctx.source, ctx.split.blocks, ctx.filename)})`.
- `types.ts`: `DiagnosticCode` gains `'vue-empty-block'`; the `build?` comment says style, react and vue.

### 2. Vite keeps a vue pick as `target-not-built` until 4.4 (`packages/vite/src/index.ts`, `load`)

Before `buildTarget`, `own.target === 'vue'` throws the diagnostic core threw before: `multifront does not build <vue>
blocks yet (target-not-built)`, at the opening tag. `react-target.spec.ts` stays as is; 4.4 removes the guard.

### 3. Editor half (`packages/language-tools/src/blocks/vue.ts`, `types.ts`, `context.ts`, `languagePlugin.ts`)

- New dependency `@vue/language-core` 3.3.11 (exact) in `@multifront/language-tools`.
- `EditorOptions` gains `ts?: TypeScript`, `compilerOptions?: ts.CompilerOptions`; `createEditorContext` spreads them.
- `EditorBlockKind`: `types?()` may return `undefined`; `editor?()` returns `EditorCode[]`
  (`EditorFile | VirtualCode`); new `serviceScript?(code)`: the TypeScript code tsserver serves as `Card.ucf.<tag>.ts`,
  found in what `editor()` made, with its ScriptKind.
- `createRootCode` wraps an `EditorFile` as today, embeds a `VirtualCode` as is; every code's id is `codeId(block)`.
- Vue half: a per-`compilerOptions` cache of `createVueLanguagePlugin(ts, compilerOptions, {...getDefaultCompilerOptions(),
  strictCssModules: true}, (id) => id)`. SFC snapshot = `vueSfcCode(...).code` with every range outside `split.blocks`
  blanked (`\r`, `\n` kept). `editor()`: no `ts` → `[]`, else the `VueVirtualCode`. Vue's `style_N` codes are left out
  by an own `embeddedCodes` getter per instance, memoised per source array. `serviceScript`: the code whose id matches
  `/^script_(ts|tsx|js|jsx)$/`. `types()`: that script as `{ext: '.ts', code, map: undefined, mappings}`.

### 4. tsserver serves `Card.ucf.vue.ts` beside the React script (new `src/targetScripts.ts`, `typescriptPlugin.ts`)

Generic over kinds with `serviceScript` (svelte in M6: `Card.ucf.svelte.ts`).

- Host decoration in the plugin callback (before Volar binds): `getScriptFileNames` adds `X.ucf.vue.ts` per `.ucf` root
  with a Vue script; `getScriptSnapshot` returns it (after making sure a ScriptInfo exists, see Problem);
  `getScriptVersion` = the `.ucf` file's; `getScriptKind`; `fileExists`.
- One Volar `Language` + `createProxyLanguageService(base)` per extra target: `X.ucf` associated-only, `X.ucf.vue.ts`
  a code with `associatedScriptMappings` to `X.ucf`, `preventLeadingOffset`. Volar's own mapping does the rest.
- Router over the main proxy: the three diagnostics methods merge main + extras on a `.ucf` file; position requests
  go to the extra proxy whose block content holds the position; the rest to main.
- Plugin options: `{compiler, ts, compilerOptions: info.languageServiceHost.getCompilationSettings()}`.

### 5. Language server (`server.ts`)

`initializationOptions.typescript.tsdk` → `loadTsdkByPath(...).typescript`, options `{ts, compilerOptions: {}}`. No
tsdk → no Vue code.

### 6. Fixtures

- `components/vue/Empty.ucf`: `<vue>` with only a comment, plus a `<style>`.
- `components/vue/VueWithUnclosedReact.ucf`: valid `<vue>` using `$style.box`, an unclosed `<react>`, then
  `<style module>` with `.box`.

## Tests

All in `pnpm devx test`, on this host and in CI's `check` job; tsserver and the language server are child processes.

- `packages/e2e/editor/vue-block.spec.ts` (new). tsserver, cwd `fixtures/components`, inferred project options set by
  `compilerOptionsForInferredProjects`:
  - `{{ count.toFixed('x') }}` in `Counter.ucf`: exactly one diagnostic, `TS2345` at `'x'`; same on
    `vue/CounterCrlf.ucf` at its CRLF location.
  - `$style.buton`: exactly one `TS2551` at `buton`.
  - quickinfo in `<react>` (`setCount`) and in `<vue>` (`const count`), definition from `{{ count }}` into `Counter.ucf`.
  - `vue/VueWithUnclosedReact.ucf`: no tsserver diagnostic.
  - Language server with a tsdk (`TSDK` moves to `editor/lib/lsp.ts`): `vue/Empty.ucf` → `[vue-empty-block]` at its
    line; `VueWithUnclosedReact.ucf` → `[unclosed-block]` only; `Counter.ucf` with a CSS error → one `css` diagnostic,
    and the hover on `color` holds its docs once.
- `packages/e2e/editor/virtualCode.spec.ts`: with `ts`, every fixture with a `<vue>` block (recursive, `invalid/`
  included) has a `vue` code, no Vue `style_N`, a snapshot of the same length and line breaks with nothing outside the
  `<vue>` content and root `<style>` blocks, a `script_ts` that `getTypesScript(..., 'vue')` returns; vue and react are
  full rows.
- Core: `blocks/index.spec.ts` (`target-not-built` svelte only; vue build equals `vueSfcCode`; `Empty.ucf` throws
  `vue-empty-block`), `check.spec.ts` (`vue/Empty.ucf` case + snapshot).
- Existing editor tests on files with a `<vue>` block stay green; a real error in a fixture's `<vue>` block is fixed in
  the fixture, never by loosening a test.

## Docs

- `docs/milestones/m4-vue-target.md`: 4.3 text (names, `$style.buton`, tsserver silent on `unclosed-block`, Vite
  guard, the serving mechanism), `- Status: done`; 4.4 `vueKind.build()`; 4.12 `$style.buton` / `$style.button`;
  "New dependencies" says which step adds each; Hands (`vueKind`, the serving names for M6).
- `docs/plan.md` "Cases later steps take over": `$style.buton`.
- `docs/architecture.md`: `EditorBlockKind` snippet; "Importing a `.ucf` file" bullet.
- `publicdocs/02-component-files.md` Block Rules and `publicdocs/07-errors.md`: `vue-empty-block`.

## Fuzzing

None (decision 5).

## Out of scope

- 4.12: root forwarding getters, Vue service plugins, the relay, the in-block `.ucf` import rule for `<vue>`.
- 4.13: importers resolving to `Card.ucf.vue.ts`, `typesRoot` in the bundle; results landing in a target script
  outside a `<vue>`-block request (navto, references from other files).
- 4.4: plugin-vue composition, lifting the Vite guard. User `vueCompilerOptions` from tsconfig.

## Done when

- `<vue>` is a full row; tsserver serves the React and Vue scripts of one `.ucf` file side by side.
- Every test above passes; `pnpm devx check` green; docs updated; 4.3 ends with `- Status: done`.
- This todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Decisions

- Vite guard keeps `target-not-built` for a vue pick until 4.4 (orchestrator: M4 "Needs" says 4.4 lifts it; a clear
  error beats a misleading parse error).
- `unclosed-block`: tsserver silent, the language server reports it (orchestrator: our diagnostics are the server's job
  in hybrid mode; twice would be a regression).
- `$style.buton` on `Counter.ucf` (orchestrator: its class is `button`; `crad` gives TS2339). 4.12 text and plan.md
  follow.
- Only `@vue/language-core` now (orchestrator: a dependency arrives with the step that first imports it).
- No fuzz test (orchestrator: the milestone's guard fixtures plus the all-fixtures sweep cover it).
