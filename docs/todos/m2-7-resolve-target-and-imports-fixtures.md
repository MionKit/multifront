---
type: feature
spec: full-plan
status: ready
created: 2026-10-10
milestone: 2
step: 2.7
---

# Milestone 2.7: `resolveTarget()` v1 in core, and the shared imports fixture set

## Problem

Spec 4.1 and 4.2 decide the framework of a `.ucf` import: the block it sits in, then a `with { framework }` attribute,
then the importer's extension, then the project default. Nothing in core implements them. 2.8 and 2.9 (TypeScript
plugin) need them now; M3 (Vite) extends the same function, keeping its signature, codes and rule order. Spec 5 and
spec 10 also want one shared fixture table the build and the editor must both satisfy. Neither exists.

Found while planning:

- `TARGETS` and `isTarget` live in `packages/core/src/index.ts:31-35`. `imports/resolveTarget.ts` importing them from
  there makes an import cycle (`import/no-cycle` is an error in `.oxlintrc.json`), so they move to their own module.
- `DiagnosticCode` is a plain union at `packages/core/src/types.ts:62-72`; no exhaustive switch over it exists.
- `orList()` (`packages/core/src/diagnostics.ts`) is the message helper the other checks use.
- oxc-parser 0.149 is already a core dependency (M1). Its ESTree gives `ImportDeclaration.attributes` /
  `ExportNamedDeclaration.attributes` (`ImportAttribute {key: Identifier|Literal, value: Literal}`) and
  `ImportExpression.options` (`{with: {framework: '...'}}` as an `ObjectExpression`).
- Core tests read e2e fixtures by relative path (`packages/core/test/check.spec.ts:4`). The e2e `tsconfig.json` does not
  include `fixtures/apps/**`, so fixture importers of `.ucf` files never reach a typecheck; `expected.ts` is typechecked
  through the core test that imports it.
- AGENTS.md: test files mirror `src/`, so the test is `packages/core/test/imports/resolveTarget.spec.ts`. M3 3.3
  already names that file.
- react 19.3.0 and @types/react 19.3.0 (2026-09-09) pass the 30-day `minimumReleaseAge`.
- M3's hand-off list (`docs/milestones/m3-react-and-imports.md:298`) still names `TargetResult` / `TargetErrorCode`,
  its 3.3 text `TargetChoice` / `TargetRule`. M3 3.2 says it "adds `oxc-parser`" to core, which has it since M1.

## Plan

### 1. Core: `resolveTarget`

- New `packages/core/src/targets.ts`: `TARGETS` and `isTarget` moved from `src/index.ts:31-35`; `index.ts` re-exports
  both (public API unchanged). Own `refactor(core)` commit.
- `packages/core/src/types.ts`: `DiagnosticCode` gains `'framework-in-block' | 'unknown-framework' | 'no-target'`. New
  types:

  ```ts
  export interface Importer {
    fileName: string;
    block?: Target; // the import sits inside that .ucf target block (spec 4.1)
  }
  export interface ResolveTargetOptions {
    framework?: Target; // the project default (spec 4.2, rule 3)
    importers?: Record<string, Target>; // extension → framework, over DEFAULT_IMPORTERS
  }
  export type TargetRule = 'block' | 'attribute' | 'importer' | 'default';
  export type TargetChoice = {target: Target; rule: TargetRule} | {error: {code: DiagnosticCode; message: string}};
  ```

- New `packages/core/src/imports/resolveTarget.ts`:
  - `DEFAULT_IMPORTERS: Readonly<Record<string, Target>>`, frozen:
    `{'.vue': 'vue', '.svelte': 'svelte', '.jsx': 'react', '.tsx': 'react'}`.
  - `resolveTarget(importer, attribute, options = {})`, in order:
    1. `importer.block` set: no attribute → `{target: block, rule: 'block'}`; any attribute (even the block's own
       framework) → `framework-in-block`,
       `a framework attribute cannot sit inside the <react> block; imports there always get react`.
    2. attribute: a `Target` → `rule: 'attribute'`; anything else → `unknown-framework`,
       `unknown framework "angular"; use vue, react or svelte` (`orList(TARGETS)`).
    3. `extname(importer.fileName)` (`node:path`) looked up with `Object.hasOwn` in
       `{...DEFAULT_IMPORTERS, ...options.importers}` → `rule: 'importer'`.
    4. `options.framework` → `rule: 'default'`.
    5. else `no-target`, naming the three ways with the merged map's extensions:
       `no framework for this .ucf import; add with {framework: 'react'} (or vue, svelte), import it from a .vue, .svelte, .jsx or .tsx file, or set the framework option`.
  - No file reads, no position: the caller adds it. A non-literal attribute is the caller's to detect (M3).
- `packages/core/src/index.ts`: export `resolveTarget`, `DEFAULT_IMPORTERS` and the types `Importer`,
  `ResolveTargetOptions`, `TargetRule`, `TargetChoice`.

### 2. Shared imports fixture set, `packages/e2e/fixtures/apps/imports/`

Every importer imports `../../../components/Card.ucf` unless noted.

- `tsconfig.json` (strict JSON): `target: es2022`, `module: preserve`, `moduleResolution: bundler`, `jsx: react-jsx`,
  `strict`, `noEmit`, `skipLibCheck`, `plugins: [{"name": "@multifront/language-tools/typescript-plugin",
"framework": "react"}]`, `include: ["src"]`.
- `src/App.tsx` (bare, renders `<Card title="Hello" />` for 2.9), `src/main.ts` (`with {framework: 'react'}`),
  `src/reexport.ts` (`export {default as VueCard} from ... with {framework: 'vue'}`), `src/lazy.ts`
  (`await import(..., {with: {framework: 'svelte'}})`), `src/bad.ts` (`framework: 'angular'`), `src/Page.vue`
  (`<script setup lang="ts">`, bare), `src/mixed.ts` (same specifier, `vue` then `react`: TypeScript keeps the last,
  so 2.9 checks real React types for both).
- So every rule and the order are proven:
  - `src/default.ts`: bare in a `.ts` → react, rule `default`.
  - `src/attribute-over-importer.tsx`: `svelte` in a `.tsx` → svelte, rule `attribute`.
  - `src/Showcase.ucf`: `<react>` with a bare import → react, rule `block`.
  - `src/BlockAttribute.ucf`: `<react>` importing `../../../components/Badge.ucf` with `{framework: 'vue'}` →
    `framework-in-block`.
  - `custom-importers/tsconfig.json` (`"importers": {".ts": "svelte", ".tsx": "vue"}`, no framework) with
    `widget.ts` (bare → svelte, `importer`) and `view.tsx` (bare → vue, `importer`: the option beats the built-in
    `.tsx`).
- `no-default/tsconfig.json` (no `framework`) with `bare.ts` → `no-target`.
- `expected.ts`:

  ```ts
  export type ExpectedImport = {
    file: string; // from this folder, '/' separators
    specifier: string;
    line: number; // 1-based, in the whole file
    options: ResolveTargetOptions; // the plugin entry of the file's tsconfig.json
  } & ({expect: Target; rule: TargetRule} | {expect: DiagnosticCode});
  export const EXPECTED_IMPORTS: ExpectedImport[];
  ```

- Root devDependencies, exact pins: `react` 19.3.0, `@types/react` 19.3.0.

## Tests

Package test `packages/core/test/imports/resolveTarget.spec.ts`, vitest project `core`, run by `pnpm devx test` on
this host and in CI's `check` job. No new infra.

- Helper `packages/core/test/imports/readImports.ts`, `readImports(fileName)`: every import of a `.ucf` path in a real
  file as `{specifier, attribute, line, block?}`. `.ts` / `.tsx`: oxc-parser on the file. `.vue`: `@vue/compiler-sfc`
  `parse`, then oxc-parser on `<script>` / `<script setup>`, offsets shifted. `.ucf`: `splitBlocks`, oxc-parser (`tsx`)
  on each `react` block shifted by `contentStart`, `block: 'react'`. Static imports, `export ... from`, `import()`
  with a literal first argument. M3's `rewriteImportAttributes` replaces it.
- `it.each` over `EXPECTED_IMPORTS`: exactly one import at `specifier` + `line` in the real file;
  `resolveTarget({fileName, block}, attribute, row.options)` gives `{target, rule}`, or `{error: {code, message}}` with
  the exact hand-written message.
- Every `.ucf` import in any file of the app has a row.
- Each row's `options` equals `framework` / `importers` of the plugin entry in the nearest `tsconfig.json`.
- `DEFAULT_IMPORTERS` equals the four spec entries and is frozen.

## Docs

- `docs/milestones/m2-editor-basics.md` 2.7: test path, row shape with `rule`, the added fixtures, `- Status: done`;
  hand-off lines for the fixture set and the fixtures.
- `docs/milestones/m3-react-and-imports.md`: line 298 names (`Importer`, `TargetChoice`, `TargetRule`), line 104 row
  shape, line 99 (core already has `oxc-parser`; 3.2 adds `magic-string` only).
- spec, plan, architecture: none (`architecture.md` "Build" already places the rules in `resolveTarget()` in core).

## Fuzzing

None: a pure 4-rule lookup; the only oracle would be a second copy of the rules. The table plus "every import has a
row" is the coverage.

## Out of scope

- Vite side, `importerFromId`, `frameworks` / `target-not-enabled`, `framework-attribute-not-literal`,
  `missing-target-block` (M3).
- `readMultifrontOptions` and the TypeScript plugin (2.8, 2.9).
- `components/imports/` fixtures (2.8's `VueOnly.ucf`).

## Decisions

- Target rows carry `rule` beside `expect`: the test checks target and rule (orchestrator).
- Extra fixtures `default.ts`, `attribute-over-importer.tsx`, `Showcase.ucf`, `BlockAttribute.ucf`,
  `custom-importers/`: every rule and the order covered (orchestrator).
- `mixed.ts` imports `vue` first, then `react`, so 2.9 sees real React types for both (orchestrator).
- Test path `packages/core/test/imports/resolveTarget.spec.ts`, mirroring `src/` (orchestrator).

## Done when

- `resolveTarget`, `DEFAULT_IMPORTERS` and the four types exported from `@multifront/core`; three codes in
  `DiagnosticCode`.
- Fixture set and `expected.ts` as above; react and @types/react pinned at the root.
- `packages/core/test/imports/resolveTarget.spec.ts` passes; `pnpm devx check` passes.
- Milestone doc 2.7 matches what shipped and ends with `- Status: done`; M3 names fixed.
- This spec moved to `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
