---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.4
---

# Milestone 2.4: `@multifront/language-tools` and the Volar language plugin

## Problem

Steps 2.1 to 2.3 give `.ucf` files highlighting only. Nothing turns a `.ucf` file into something a language service can
read. Hybrid mode (spec 6) needs a Volar `LanguagePlugin`: tsserver gets the `<react>` block as TSX (2.8, 2.9), our
language server the `<style>` blocks as CSS or SCSS (2.6). Every later editor step builds on it and on the editor half
of the block registry. Neither exists, nor does the package `@multifront/language-tools`.

Found while planning (`@volar/language-core` and `@volar/typescript` 2.4.28, TypeScript 6.0.3, typechecked under the
repo's `tsconfig.base.json` in a scratch folder):

- **2.4.28 is the latest Volar** (2026-01-31), outside the 30-day release-age window, and the version spike 1 ran on.
  `@volar/language-core` depends only on `@volar/source-map`; `@volar/typescript` adds `vscode-uri` and
  `path-browserify`, no peers.
- **The `typescript` field of `LanguagePlugin`** is a module augmentation in `@volar/typescript` (`lib/common.d.ts`):
  a type-only import from `@volar/typescript` (`TypeScriptServiceScript`) switches it on. `skipLibCheck` hides its
  augmentation of the absent `@volar/language-service`. The emitted `.d.ts` keeps only the `@volar/language-core`
  import, so a consumer of `dist/` lost the field (`TS2339` on `.typescript`; the built-types test pins it):
  `languagePlugin.ts` carries `/// <reference types="@volar/typescript" preserve="true" />`, which tsc keeps (a
  type-only `import type {} from` is dropped). oxlint's `typescript/triple-slash-reference` is turned off for that one
  line only.
- **No runtime TypeScript needed.** `scriptKind: 4 satisfies ts.ScriptKind.TSX` and `7 satisfies ts.ScriptKind.Deferred`
  typecheck against `import type * as ts from 'typescript'`, and a wrong number fails (`TS1360`), the same pattern as
  Vue's language-core. So `createUcfLanguagePlugin()` takes no `ts`, and in 2.4 the package imports nothing from Volar
  or TypeScript at runtime.
- **`.tsx` snapshots under `packages/e2e/editor/`** would be typechecked (e2e's `tsconfig.json` includes `editor`, and a
  directory include takes `.tsx`) and linted (oxlint runs over the whole repo). Both must skip `__snapshots__`. oxfmt
  formats only `*.{ts,md}`, so it never rewrites a snapshot.
- **A vitest project with no test file is fine**: `packages/vscode` already is one. The 2.4 tests are all e2e.

## Plan

1. **Package `packages/language-tools`**, `@multifront/language-tools`, published (same shape as `packages/core`):
   - `package.json`: `type: module`, MIT, author, homepage, `repository` with `directory`, bugs, `sideEffects: false`,
     `publishConfig.access: public`, `files: ["dist", "!dist/**/*.tsbuildinfo"]`. `exports["."]` =
     `{source: ./src/index.ts, types: ./dist/index.d.ts, default: ./dist/index.js}`. Only `.`: `./server` lands with its
     code in 2.6, `./typescript-plugin` and the `typescript-plugin/` folder in 2.9. Dependencies (exact pins):
     `@multifront/core` `workspace:*`, `@volar/language-core` `2.4.28`, `@volar/typescript` `2.4.28`. Peer: `typescript`
     `^6.0.0`. devDependency `typescript` `6.0.3` (packages/AGENTS.md: a package carries the devDependencies for its own
     peers).
   - `tsconfig.json` (check only) and `tsconfig.build.json` (emit, `references` core), as core's. `vitest.config.ts`,
     project `language-tools`, `test/**/*.spec.ts`. `README.md`: thin (description, repo link, status, license).
   - Root: `tsconfig.json` references `./packages/language-tools/tsconfig.build.json`; `vitest.config.ts` projects gets
     `'packages/language-tools/vitest.config.ts'`; `README.md` packages table gets a row. `@multifront/e2e` gets
     `"@multifront/language-tools": "workspace:*"`. `pnpm-lock.yaml` updated by `pnpm install`.
2. **`src/types.ts`**: `EditorBlockKind`, `EditorFile` (`extends VirtualFile`, `mappings: CodeMapping[]`, `map` stays
   `undefined`), `EditorContext` (`{split, modules: Record<string, EditorStyleModule>}`), `EditorStyleModule`
   (`Pick<StyleModule, 'name' | 'index'>` from core, plus `classes: StyleClass[]`), `StyleClass` (`{name, offset?}`): the shapes of the step text. Nothing fills
   `modules` in 2.4; 2.5 does.
3. **`src/mappings.ts`**: `ALL_FEATURES: CodeInformation` (verification, completion, semantic, navigation, structure,
   format all `true`) and `contentMapping(block): CodeMapping`
   (`{sourceOffsets: [contentStart], generatedOffsets: [0], lengths: [content.length], data: ALL_FEATURES}`).
4. **`src/blocks/`**, the editor half of the registry, one file per tag (architecture.md "Where the code lives"):
   - `style.ts`: `editor(block)` returns one `{ext, code: block.content, map: undefined, mappings: [contentMapping(block)]}`;
     `ext` is `.css` for no `lang` or `lang="css"`, `.scss` for `lang="scss"` (an `Object.hasOwn` lookup). Any other
     `lang` (`less`, `sass`, `styl`, `stylus`, `postcss`, unknown, bare) gives `[]`.
   - `react.ts`: `editor(block)` returns one `.tsx` code, the same way. No `types()` yet (2.5).
   - `vue.ts`, `svelte.ts`: `{tag}` only (M4, M6).
   - `index.ts`: `KINDS_BY_TAG: Record<BlockTag, EditorBlockKind>` in core's key order (a missing tag fails typecheck);
     `EDITOR_BLOCK_KINDS = Object.values(KINDS_BY_TAG)`.
5. **`src/languagePlugin.ts`**: `createUcfLanguagePlugin(): LanguagePlugin<string>`, no parameter; the first step that
   needs an option adds it.
   - `getLanguageId(fileName)`: `'ucf'` for `.ucf`, else `undefined`.
   - `createVirtualCode(fileName, languageId, snapshot)`: `undefined` unless `ucf`. Splits once with
     `splitBlocks(source, fileName)`, `ctx = {split, modules: {}}`, loops `EDITOR_BLOCK_KINDS` in registry order (shared
     rows first). A row's blocks follow core's `isTarget(tag)`: a shared row gets every block of its tag, a target row
     gets `split.targets[tag]` only (the first, as the build takes). Each returned file becomes an embedded
     `VirtualCode`: `id` = the tag for a target (`react`), `<tag>_<block.index>` for a shared block (`style_0`, ...);
     `languageId` from `ext` (a total `Record<VirtualFile['ext'], string>`: `.tsx` → `typescriptreact`, `.css` → `css`,
     `.scss` → `scss`, `.ts` → `typescript`, `.vue` → `vue`, `.svelte` → `svelte`); a small string snapshot; the file's
     `mappings`. Root code: `id: 'root'`, `languageId: 'ucf'`, the incoming snapshot, one 1:1 mapping over the whole
     source with `ALL_FEATURES` (2.6's `multifront` service reports on the root document), and `embeddedCodes`.
   - `typescript.extraFileExtensions`: `[{extension: 'ucf', isMixedContent: true, scriptKind: 7 satisfies ts.ScriptKind.Deferred}]`.
   - `/// <reference types="@volar/typescript" preserve="true" />` at the top, so the built types keep the
     `typescript` field (Problem).
   - `typescript.getServiceScript(root)`: the `react` code as `{code, extension: '.tsx', scriptKind: 4 satisfies ts.ScriptKind.TSX}`,
     `undefined` with no `<react>` (spike 1, answer 3: no extra service scripts).
6. **`src/index.ts`**: exports `createUcfLanguagePlugin`, `EDITOR_BLOCK_KINDS` and the five types.
7. **Repo config**: `packages/e2e/tsconfig.json` gets `"exclude": ["**/__snapshots__"]`; `.oxlintrc.json`
   `ignorePatterns` gets `"**/__snapshots__/**"`. Root devDependency `@volar/language-core` `2.4.28` (exact pin), so
   the test runs the plugin through Volar's own registry.

## Tests

Two files, area Editor, vitest project `e2e`. Both run on this host and in CI's `check` job (`pnpm devx test`); they
need only Node and the pnpm install. No new infra (milestones README: "Editor: tsserver, LSP, vsix | nothing").

`packages/e2e/editor/virtualCode.spec.ts` loads `createUcfLanguagePlugin()` into Volar's real
`createLanguage([plugin], new Map(), () => {})` and sets each file with `language.scripts.set(filename,
ts.ScriptSnapshot.fromString(source))` (real `typescript` snapshot), so Volar picks the language, builds the codes and
keeps them by id. Every name in `listComponents()`, `listComponents('invalid')`, `listComponents('langs')` (no code
for `sass` and `postcss`) and `listComponents('editor')` (`GrammarEdges.ucf`: `lang` on a later line, `lang='less'`,
`title="a lang=scss b"` gives `.css`). Per file:

- the script's language is `ucf`; the root code is `root` / `ucf`, its text equals the source, and its one mapping
  covers the whole source with every feature on.
- **The kept blocks**: the embedded ids equal the list built from the real `splitBlocks`: `style_<i>` for each style
  with no `lang`, `css` or `scss`, then `react` when `split.targets.react` exists; each with its `languageId`. Covers
  `invalid/DuplicateReact.ucf` (`style_0` and the first `react`), `invalid/UnknownStyleLang.ucf` (react only),
  `invalid/StylesOnly.ucf` (no react). Volar's `generated.embeddedCodes` holds `root` and those ids.
- **Exact mappings**: for every code, root included, and every segment, the source slice equals the generated slice.
- **Whole block, all features**: through Volar's mapper (`language.maps.get(code, script).toGeneratedLocation`), every
  offset of the block's `[contentStart, contentEnd)` maps to the same character, and every mapping has every feature on
  (2.5's extra unmapped `$style` lines keep this true).
- **Service script**: `getServiceScript(root)` is the `react` code with `.tsx` and `ScriptKind.TSX`, or `undefined`
  with no react; `extraFileExtensions` has `ucf`.
- **Snapshots**: each embedded code's text, `toMatchFileSnapshot('__snapshots__/virtualCode/<name>.<id><ext>')`
  (`virtualCode/Card.ucf.react.tsx`, `virtualCode/invalid/DuplicateReact.ucf.style_0.css`). The `virtualCode/` folder
  keeps them apart from 2.5's `Card.ucf.react.tsx` types snapshot.
- **Halves check**: `EDITOR_BLOCK_KINDS.map(tag)` equals `BLOCK_KINDS.map(tag)`.
- **Not a `.ucf` file**: `getLanguageId` is `undefined` for the real `fixtures/apps/vue-reference/src/main.ts`, and
  `language.scripts.set(it, ..., 'typescript')` gets no generated code.

`packages/e2e/editor/builtTypes.spec.ts` runs the real `tsc --build packages/language-tools/tsconfig.build.json`, then
`tsc -p` on the new fixture `packages/e2e/fixtures/apps/language-tools-dist/` (no `source` condition, so the import
resolves to `dist/*.d.ts`), which reads `createUcfLanguagePlugin().typescript!.extraFileExtensions`. Both exit 0 with no
output.

Each check confirmed to fail without its behaviour (a `style_<n>` id off by one, a mapping shifted by one, the style row
moved last, a missing row, no `scss` code, no `languageId` check, a root mapping of length 0, no `reference` line).

## Docs

- `docs/milestones/m2-editor-basics.md`: `- Status: done` on 2.4; the 2.4 Build text (only `.`, no `options`) and Test
  text (snapshot path); `./server` into 2.6's Build; `./typescript-plugin` and the `typescript-plugin/` folder into
  2.9's Build; "Hands to later milestones": `createUcfLanguagePlugin()` (later steps add options) and the folder from
  2.9. No m3 to m7 doc names `createUcfLanguagePlugin`.
- `docs/architecture.md` "Block kinds" code block: `EditorFile`. "Where the code lives": the language-tools style row
  reads `editor`.
- `docs/plan.md` "Packages": `@multifront/language-tools` "When" becomes `exists`, and `packages/vscode` too (it has
  existed since 2.2).
- Root `README.md` packages table: one row. `docs/spec.md`, `SETUP.md`: none (no new command or behaviour).
  `publicdocs/`: the milestone's docs writer.

## Fuzzing

None in 2.4: each code is a verbatim copy of a `splitBlocks` block, whose offsets the 1.5 splitter fuzz test already
pins. Worth it once mappings stop being 1:1 (2.5 `$style`, M4 Vue codes).

## Out of scope

- `types()`, typed `$style`, filling `ctx.modules`, `getTypesScript` (2.5).
- The server, the TypeScript plugin, import resolution (2.6, 2.8, 2.9), and their subpaths.
- `<vue>` and `<svelte>` codes (M4, M6); codes for `less`, `sass`, `stylus`, `postcss` (highlighting only).

## Decisions

- Subpaths: only `.` in 2.4; `./server` moves to 2.6, `./typescript-plugin` and its folder to 2.9 (orchestrator).
- `createUcfLanguagePlugin()` takes no parameter; the first step that needs an option adds it (orchestrator).
- No fuzz test in 2.4: the milestone puts none in this step (orchestrator).
- Review: dropping `modules`, `EditorStyleModule`, `StyleClass`, `types?`, `ctx`, the type exports and the snapshots
  was declined: the 2.4 step text sets those names, shapes and file snapshots as its floor and hands them to 2.5 and M7.

## Done when

- `@multifront/language-tools` exists, in the root build graph and test projects; `pnpm devx check` passes.
- `createUcfLanguagePlugin()` turns every fixture into exact, 1:1-mapped TSX and CSS / SCSS codes;
  `packages/e2e/editor/virtualCode.spec.ts` passes locally and in CI, and executes there.
- Milestone doc, architecture.md and plan.md match what shipped; the spec is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
