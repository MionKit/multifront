---
type: feature
spec: full-plan
status: done
created: 2026-10-15
milestone: 7
step: 7.3
---

# mf-tsc also checks .vue importers

## Problem

`mf-tsc` (7.1, 7.2) builds one program per tsconfig through Volar's `proxyCreateProgram` with our `.ucf` language
plugin only (`createChecked`'s `languagePlugins` in `packages/language-tools/src/tsc/program.ts`). A `.vue` file is
not even in the program: `projectAt` in `tsc/index.ts` gives `ts.getParsedCommandLineOfConfigFile` only `ucf` as an
extra extension, so `include` never
picks `Page.vue`. A Vue project with `.ucf` files needs `vue-tsc` beside `mf-tsc`, and `vue-tsc` cannot read `.ucf`
imports, so in practice it has no checker. Milestone 7.3: one command type-checks `.vue` files, their `.ucf` imports
resolved to the Vue target.

Checked in memory before planning: `@vue/language-core` 3.3.11's `createVueLanguagePlugin` in the same
`languagePlugins` list, beside ours, inside our `inner` with `withUcfResolution`. `BadPage.vue` with
`<OnlyReactExport :label="1" />` gives one TS2322 at line 6, column 21, length 5 (`label`), mapped into the `.vue`
text. Its import resolves to `OnlyReactExport.ucf.vue.ts` (core's `DEFAULT_IMPORTERS`: `.vue` is `vue`). A valid
`Page.vue` under `noUnusedLocals` / `noUnusedParameters` gives no diagnostics.

## Decisions

Answers from the run-milestone orchestrator:

1. The tsconfig's `vueCompilerOptions` apply to `.vue` files: read with `createParsedCommandLine`, extensions from
   `getAllExtensions`, as `vue-tsc` does. `.ucf` `<vue>` blocks keep our own options.
2. A parity test with the real `vue-tsc` on a plain `.vue` file goes in (test 5).

## Plan

1. `packages/language-tools/src/tsc/index.ts`:
   - `Project` gains `vueOptions: VueCompilerOptions` (type from `@vue/language-core`, already a pinned dependency).
   - `projectAt` first reads it with `createParsedCommandLine(ts, ts.sys, key).vueOptions`, as `vue-tsc` does: the
     tsconfig's `vueCompilerOptions`, `extends` followed, never throws.
   - The file-wide `extraFileExtensions` moves into `projectAt`: `ucf` plus `getAllExtensions(vueOptions)` (`.vue` by
     default, plus `vueCompilerOptions.extensions`), each `{isMixedContent: true, scriptKind: ts.ScriptKind.Deferred}`.
     So `include` picks up `.vue` files.
   - `checkedOf` passes `project.vueOptions` to `createChecked`.
   - `MF_TSC.summary` becomes `Type-checks .ucf files in every framework, with the .ts, .tsx and .vue files that import them.`
2. `packages/language-tools/src/tsc/program.ts`: `createChecked(ts, configFile, parsed, vueOptions)` adds
   `createVueLanguagePlugin(ts, options, vueOptions, (id) => id)` after `createUcfLanguagePlugin(editorOptions)`, the
   same compiler options for both. Nothing else changes:
   - `.vue` diagnostics go through `check()`'s existing non-`.ucf` path (Volar's proxied `getSyntacticDiagnostics` /
     `getSemanticDiagnostics`, mapped into the `.vue` text). Ones Vue maps nowhere are dropped, as in `vue-tsc`.
   - `getSplit` is `undefined` for a `.vue` file, so its findings carry no `block` / `framework` (milestone: "a `.ts`,
     `.tsx` or `.vue` file carries neither").
   - Our import errors (`withImportErrors`, wrapped before Volar decorates the program) map into `.vue` files too.
3. `.ucf` `<vue>` blocks keep their own Vue options (`blocks/vue.ts`: defaults plus `strictCssModules`), as in
   tsserver today. The tsconfig's `vueCompilerOptions` apply to `.vue` files only.
4. Fixtures:
   - `packages/e2e/fixtures/apps/types-every-target/Page.vue` (valid): `<script setup lang="ts">` imports
     `./Greeting.ucf`, template `<Greeting name="Ada" :count="2" />`. Its `include: ["."]` already picks it.
   - `packages/e2e/fixtures/apps/types-broken/BadPage.vue`: imports `./OnlyReactExport.ucf` (its `<vue>` block takes
     `label: string`), template `<OnlyReactExport :label="1" />`.
   - `types-broken/tsconfig.json` `include`: `["*.ucf", "*.ts", "*.vue", "pages"]`.
5. Shared helpers, `packages/e2e/editor/lib/tsc.ts`:
   - `BAD_PAGE = expected('BadPage.vue', ':label="1"', 'label', {code: 'TS2322', severity: 'error', message: NOT_STRING})`.
   - It joins `BROKEN_FINDINGS` at its place in print order (program file order): first, as `BadPage.vue` comes
     first in the program.
   - `BROKEN_FILES` becomes 8.
6. Existing specs follow the new fixture files:
   - `react.spec.ts`: `INCLUDE`, `checked 5 files` on the valid app, the error count from `BROKEN_FINDINGS.length`,
     and the final `HELP` summary line (the help test the step says pins the final help).
   - `every-target.spec.ts`: `BAD_PAGE` in the whole-project `--framework svelte` lines (a `.vue` file is checked as
     usual, so 4 errors there), the `include` edit strings, `checked 5 files` under `noUnusedLocals`.

## Tests

Area Editor, new `packages/e2e/editor/tsc/vue-importer.spec.ts`. Each test spawns the real `mf-tsc` bin (`runMfTsc`)
on `copyApp()` temp copies. They run on this host and in CI's `check` job (`pnpm devx test`), needing only what the
7.1 / 7.2 specs use, plus `vue-tsc` 3.3.11 (already a root devDependency, run through the existing `typeCheck()` in
`build/lib/library.ts`). No new infra.

1. Valid app: `mf-tsc Page.vue` exits 0 with `checked 1 file with tsconfig.json: no errors`. The whole valid app
   (`checked 5 files`) and the broken one's whole-project document, `BAD_PAGE` with its text `label`, are pinned by
   the updated `react.spec.ts`.
2. `mf-tsc BadPage.vue` reports only that finding: exit 1, stdout exactly
   `BadPage.vue:6:21: error TS2322: Type 'number' is not assignable to type 'string'.` and
   `mf-tsc: checked 1 file with tsconfig.json: 1 error`. With `--format json`: the exact document,
   `projects: [{tsconfig: 'tsconfig.json', files: 1}]`.
3. The `.vue` importer gets the Vue target: a temp edit makes `BadPage.vue` import `./Title.ucf` (no `<vue>` block).
   One `missing-target-block` finding at the specifier, `./Title.ucf has no <vue> block; BadPage.vue imports it as
   vue`, no TS2307.
4. The tsconfig's `vueCompilerOptions` apply:
   - In the valid copy, `Page.vue` passes an unknown prop, and so does `Greeting.ucf`'s `<vue>` block (to `Badge`):
     exit 0 without the option. Then the create-vue layout: root `{"files": [], "references": [...]}`,
     `tsconfig.app.json` with `"extends": "./vue.json"`, `vue.json` holding `strictTemplates: true`. The whole
     project and `-p tsconfig.app.json Page.vue` both give exactly one error, at `Page.vue`'s `extra`: the option
     comes through `extends`, from the referenced project's own config, and never reaches a `.ucf` `<vue>` block.
   - With `"extensions": [".vue", ".page"]` (the app's `include: ["."]` then picks it), an `Extra.page` with a script
     type error is reported at its line and column.
5. Parity with `vue-tsc`: a temp `plain/` project in the broken copy (a tsconfig and a `Plain.vue` with one script
   error and one template error, no `.ucf` import). Real `vue-tsc -p tsconfig.json --pretty false` and real
   `mf-tsc --format json` in that folder give the same codes at the same lines and columns.

The updated `react.spec.ts` and `every-target.spec.ts` stay green with the new fixture files counted.

## Docs

- `docs/spec.md` section 5, "Where it runs": one sub-bullet. `.vue` files are checked in the same program, through
  `@vue/language-core` with the tsconfig's `vueCompilerOptions`. Their `.ucf` imports take the Vue target, so
  `mf-tsc` replaces `vue-tsc` in a project with `.ucf` files.
- `docs/architecture.md`, the `mf-tsc` paragraph: `@vue/language-core`'s language plugin beside ours in
  `proxyCreateProgram`, the tsconfig's Vue extensions as extra file extensions, `.ucf` `<vue>` blocks keeping our own
  Vue options. No graphic shows `mf-tsc`'s plugins.
- `docs/milestones/m7-full-editor-support.md`: `- Status: done` under 7.3; step text fixed if what shipped differs.
- `publicdocs/`: no page describes `mf-tsc` yet. Unchanged.

## Fuzzing

None. The milestone puts no fuzz test in 7.3. The cheap oracle, `vue-tsc`, is used as the fixed-case parity test 5.

## Out of scope

- `.svelte` importers (milestone open question 3).
- `.ucf` `<vue>` blocks following the tsconfig's `vueCompilerOptions` (tsserver does not either).
- tsserver parity for `.vue` files: Vue's own tsserver plugin serves them, covered by M4's `editor/vue-importer.spec.ts`.
- Vue language plugins named in `vueCompilerOptions.plugins` that fail to load: Vue's resolver warns, as in `vue-tsc`.

## Done when

- `mf-tsc` checks a tsconfig's `.vue` files, their findings in the `.vue` text, their `.ucf` imports resolved to the
  Vue target; the help summary names `.vue`.
- `vue-importer.spec.ts` and the updated 7.1 / 7.2 specs pass; `pnpm devx check` green.
- Spec, architecture and milestone docs updated; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
