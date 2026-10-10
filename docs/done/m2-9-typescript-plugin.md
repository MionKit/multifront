---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.9
---

# Milestone 2.9: TypeScript plugin

## Problem

2.8 shipped the plugin entry, resolution and import errors. Left:

- `createUcfLanguagePlugin()` gets no compiler (`packages/language-tools/src/typescriptPlugin.ts:107`), so inside
  `Card.ucf`'s `<react>` the scss module `$style` is typed loosely: `completionInfo` after `$style.` gives `[]`,
  `definition` on `$style.card` gives `[]` (checked over the real tsserver).
- A vue / svelte pick is left unresolved with TypeScript's bare TS2307 (`lazy.ts`, `custom-importers/view.tsx`
  today): no framework, no rule in the message.
- `mixed.ts`: both imports get the React types (checked), but nothing warns.

Found while planning:

- `loadVueCompiler(root)` (`packages/core/src/vueCompiler.ts:7`) throws when the project has no
  `@vue/compiler-sfc`, the usual React-only project. Called bare in the plugin factory it would stop the whole plugin
  from loading. The plugin catches, logs, falls back to no compiler.
- Card.ucf opened after App.tsx joins the imports app project (`projectInfo` gives `apps/imports/tsconfig.json`):
  rename, references and unsaved edits run in one program with no new tsconfig.
- `definition` on a react row's specifier gives `Card.ucf` (line 1, offset 1): a cheap "resolves to the `.ucf`" check.
- tsserver's `change` command sends no response, so the harness cannot await it. Unsaved edits go through
  `updateOpen` `changedFiles`: the same text change, with an answer (2.8 does the same).
- M3 already plans `target-not-built` for a vue / svelte pick the build cannot serve yet (m3 lines 120, 162, 304),
  with the same lifecycle as "no types yet": M4 drops vue from it, M6 deletes it.

## Plan

### 1. Core: codes

- `packages/core/src/types.ts` `DiagnosticCode`: `'target-not-built'` and `'mixed-frameworks'` join.

### 2. `packages/language-tools/src/resolve.ts`

- `UcfResolution` (`src/types.ts`) gains `target?: Target`: the framework this import picked, undefined when
  `resolveTarget` gave an error. The plugin needs it for the mixed warning.
- Target not `MAIN_SCRIPT_TARGET`, file found by TypeScript, no `missing-target-block` →
  `{resolvedModule: undefined, target, error: {code: 'target-not-built', message}}`, message
  `../../../components/Card.ucf is imported as vue (by its framework attribute); multifront has no vue types yet`.
  Rule phrase from the `TargetChoice` rule: `its framework attribute`, `the importer's extension`,
  `the default framework`, `the block it sits in`. Relative path helper shared with `missing-target-block`.
  Missing file → TypeScript's own TS2307, no error of ours (unchanged).

### 3. `packages/language-tools/src/typescriptPlugin.ts`

- Compiler: `loadVueCompiler(info.project.getCurrentDirectory())` in try/catch; on failure
  `info.project.projectService.logger.info('multifront: no Vue compiler, $style reads plain CSS modules only (<reason>)')`
  and no compiler.
- `importErrors`: walks literals in source order (as now), keeps each resolution's `target`. A literal whose specifier
  text had an earlier import with another `target` gets `{code: 'mixed-frameworks', category: Warning, source:
  'multifront'}` at the specifier: `<specifier> is imported as vue and as react in this file; TypeScript keeps one
  resolution per specifier, so every import of it here gets the last one's types. Import each framework from its own
  small re-export file`. Each import's own resolver error is still reported. Category: Error for resolver errors,
  Warning for `mixed-frameworks`. The "one problem, one error" filter counts errors only: a warning hides none of
  TypeScript's own errors on its import (review).

### 4. Fixture

- `packages/e2e/fixtures/components/editor/TypeError.ucf`: `<react>` with `function Total({ count }: { count: number
  })` assigning `count` to `const label: string`. Splitter-valid (2.2 grammar test reads it); 2.4's loop gets the
  committed snapshot `editor/__snapshots__/virtualCode/editor/TypeError.ucf.react.tsx`.

### 5. Tests move

- `blockImports.spec.ts` drops its `.ts and .tsx importers` describe (App.tsx definition, reexport.ts) and stops
  opening those files: both now live in `tsserver.spec.ts` (reexport.ts now expects `target-not-built`). `locate()`
  moves into `editor/lib/tsserver.ts` as an export, with its reverse `offsetAt(source, location)`, `open(server, files)`,
  `inBlock(component, tag, span)` and the `TsDefinitions` type, used by both specs.

## Decisions

- Orchestrator: "no types yet" reuses M3's planned `target-not-built` (one code per error, same lifecycle).
- Orchestrator: `target-not-built` is an error in the editor, as in the build; only `mixed-frameworks` is a warning,
  so `UcfResolution` gains only `target?`.
- Orchestrator: the no-compiler test runs on a `mkdtemp(os.tmpdir())` project, removed after: it needs a project where
  `@vue/compiler-sfc` cannot be found, the opposite of `copyApp()`'s in-repo copies.
- Orchestrator: unsaved edits use `updateOpen` `changedFiles` in place of the `change` command (it answers).

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`): child processes only, which the README infra table
lists as "nothing to add".

`packages/e2e/editor/tsserver.spec.ts` (area **Editor**), one `startTsserver({cwd: apps/imports, plugins:
['@multifront/language-tools/typescript-plugin']})` with every `.ts` / `.tsx` importer, `Card.ucf` and
`editor/TypeError.ucf` open:

- **Every `EXPECTED_IMPORTS` row with a `.ts` / `.tsx` file, except `src/mixed.ts`** (`it.each`):
  - react rows: no diagnostic on the row's line; `definition` on the specifier gives `[Card.ucf]`;
  - vue / svelte rows: exactly one diagnostic on the line, `{code: 'target-not-built', source: 'multifront',
    category: 'error'}`, at the specifier's quote, text containing `imported as <expect>` and the row rule's phrase;
  - error rows (`bad.ts` `unknown-framework`, `no-default/bare.ts` `no-target`): exactly one, the row's code, at the
    specifier, `source: 'multifront'`, `category: 'error'`.
- **App.tsx**: `quickinfo` on `<Card` contains `{ title: string; }`; `definition` on `<Card` lands in `Card.ucf`
  inside `<react>`; an unsaved `updateOpen` turning `title="Hello"` into `title={1}` gives TS2322 on that line,
  reverted after.
- **mixed.ts**: `quickinfo` on `VueCard` and `ReactCard` both contain `title: string`; line 3 has exactly the
  `mixed-frameworks` warning (`category: 'warning'`, text naming the re-export file); line 2 only `target-not-built`.
- **Inside Card.ucf's `<react>`**: `completionInfo` after `$style.` lists `card`; `quickinfo` on `title` in
  `<h2>{title}</h2>` contains `string`; `definition` on `$style.card` starts at `card` in `.card {`.
- **TypeError.ucf**: exactly one diagnostic, TS2322, at the `.ucf` line and offset of `label`.
- **One program**: an unsaved `updateOpen` on Card.ucf renaming `title` to `heading` in the `<react>` signature makes
  App.tsx report TS2322 at once (reverted after); `rename` on `title` in Card.ucf lists App.tsx; `references` on
  `title` in App.tsx lists a location in Card.ucf inside `<react>`.
- **Review additions** (unsaved edits, reverted after): `mixed.ts` gains `import {Nope}` from Card.ucf as react and
  `./Gone.ucf` as vue then react: the `Nope` line keeps TypeScript's own error beside the warning, `Gone` as vue is
  TS2307, `Gone` as react TS2307 plus the warning (a `target` from an import TypeScript cannot find still counts);
  `lazy.ts` pointed at `imports/VueOnly.ucf` (svelte) gives one `missing-target-block`, not `target-not-built`.
- **No `@vue/compiler-sfc`**: a second tsserver on a temp project in `os.tmpdir()` (a copy of `Card.ucf`, a tsconfig
  with `include: ["*.ucf"]`): no TS2304 / TS2339 (without the plugin the raw file reads as TSX and `$style` is TS2304),
  `quickinfo` on `title` inside `<react>` shows `string`; `completionInfo` after `$style.` has no `card` (scss typed
  loosely). Its plugin entry has `framework: 'svelte'`, and a bare `default.ts` there gives `target-not-built` naming
  "the default framework". Temp dir removed after. The first two cases fail with the try/catch removed (checked).

## Docs

- `docs/milestones/m2-editor-basics.md`: 2.9 Build (compiler + fallback, `target-not-built` error /
  `mixed-frameworks` warning, `UcfResolution.target`), Test as shipped, `- Status: done`; 2.8 Test: App.tsx /
  reexport.ts moved to 2.9; hand-offs: `UcfResolution` plus `target?`, the two codes (M4 drops vue from
  `target-not-built`, M6 deletes it), `locate()` in the tsserver helper.
- `docs/milestones/m3-react-and-imports.md:120`: `target-not-built` already in `DiagnosticCode`: M2 (2.9) reports it in
  the editor.
- spec / plan / architecture: none (plan.md spike 1 answer 2 already says the plugin warns). No public page covers the
  editor.

## Fuzzing

None: the step names no fuzz test; the only cheap oracle is 2.7's rows table, which these tests already walk.

## Out of scope

- The spike's `module: nodenext` attribute case: the 2.9 test list leaves it out, and a nodenext sub-project would add
  `expected.ts` rows the M3 build must also pass. `module: preserve` stays covered (`main.ts` clean).
- `.vue`, `.svelte`, `.jsx` importer rows in tsserver (M4, M6); per-target scripts (M4).
- Extension bundling and the plugin pack (2.10).

## Done when

- `tsserver.spec.ts` passes, and fails with the compiler removed, with the try/catch removed, without
  `target-not-built`, without the mixed warning.
- `blockImports.spec.ts` passes after the move; `pnpm devx check` green; snapshot committed; m2 and m3 docs updated.
- The simplify-comments pass ran on every touched source file, committed on its own.
