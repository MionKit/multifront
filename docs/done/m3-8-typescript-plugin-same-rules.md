---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.8
---

# Milestone 3.8: The TypeScript plugin uses the same rules

## Problem

The plugin already calls core's `resolveTarget` with the `frameworks`, `framework` and `importers` of its tsconfig
entry (`packages/language-tools/src/resolve.ts:53`, `entryOptions` at `:107`): no copy of the rules is left. Gaps:

- A non-literal attribute (`no-default/non-literal.ts`, `import('…/Card.ucf', {with: {framework}})`) reads as no
  attribute (`frameworkValue`, `resolve.ts:28`), so the editor says `no-target`; with a default framework it would
  even resolve to react. The build fails it with `framework-attribute-not-literal`
  (`packages/core/src/imports/rewrite.ts:62`, through the post plugin `packages/vite/src/attributes.ts`).
  `seams.spec.ts:80` pins today's `no-target`.
- `.js` / `.jsx` importers (`src/Widget.jsx`, `no-default/importer.jsx`, now `jsx-importer.jsx`, `no-default/plain.js`) are react rows the
  build resolves (3.7), but the imports tsconfigs have no `allowJs`: those files are not in their configured projects
  (tsserver puts them in an inferred project with no plugin entry), so they would match only by luck.
- Nothing editor-side walks "every row the build resolves to react": the row loop in
  `packages/e2e/editor/tsserver.spec.ts:62` covers `.ts` / `.tsx` / `.ucf` rows only and leaves out `non-literal.ts`.

## Plan

### 1. `packages/language-tools/src/resolve.ts`

- New private `attributeError(literal, sourceFile): Diagnostic | undefined`: the `imports` and `errors` of
  `rewriteImportAttributes(sourceFile.text, sourceFile.fileName)`, cached in a `WeakMap<ts.SourceFile, …>` (a new
  SourceFile per edit: one oxc parse per file version). An error belongs to the last `.ucf` import that ends before it
  (`imports.findLast(({end}) => end <= error.start)?.end === literal.end`; `end` is a plain field, set during
  resolution), so an `import()` nested in another's options takes only its own error (review). Never called for a
  `.ucf` importer (`importer.block` set): block imports never go through the rewrite (3.2); inside a block the 3.4
  `framework-in-block` reading stays.
- `resolveUcfImport(ts, literal, containingFile, options, sourceFile)`: new required last parameter, the importer as
  TypeScript parsed it (tsserver's `resolveModuleNameLiterals` always passes `containingSourceFile`). Before
  `resolveTarget`: this literal's rewrite error returns `{resolvedModule: undefined, error}` (the core `Diagnostic`
  as is): same code, message and span as the build, the
  import unresolved as the build fails it. A file with a syntax error gets no rewrite result (its compiler reports it),
  so the current reading stays: typing in a broken file does not flip types.
- `packages/language-tools/src/types.ts:63` `UcfResolution.error`: `Pick<Diagnostic, 'code' | 'message'> &
  Partial<Pick<Diagnostic, 'start' | 'end'>>`; `start` / `end` say where it goes when not the specifier.

### 2. `packages/language-tools/src/typescriptPlugin.ts`

- `importErrors` (`:29`): passes `sourceFile`; `report(literal, error, warning?)` takes the `UcfResolution` error and
  puts it at `error.start` / `end` when set, else on the literal (as now).
  The "one problem, one error" filter already covers the whole `import()` call, so TS2307 on it stays hidden.
- `resolveModuleNameLiterals` (`:132`): passes its `sourceFile` argument.

### 3. Fixture

- `packages/e2e/fixtures/apps/imports/tsconfig.json`: `"allowJs": true` (sub-projects extend it), so `.js` / `.jsx`
  importers join their configured project with their own plugin entry, as a real React app with `.jsx` files does.
  No `checkJs`.
- `no-default/importer.jsx` → `no-default/jsx-importer.jsx` (its `expected.ts` row and core's rewrite snapshot with
  it): TypeScript leaves a `.jsx` out of a project that has a `.tsx` of the same name, so `importer.jsx` stayed in an
  inferred project even with `allowJs` (found by the `projectInfo` check).

### 4. Tests move

- The row loop, `ROWS` and `RULE_REASON` move from `tsserver.spec.ts` to the new `editor/imports.spec.ts`.
  `tsserver.spec.ts` keeps App.tsx, mixed.ts, the missing-block edit (still opens `src/lazy.ts`), the in-block cases,
  one program and the no-compiler project. Its stale ".jsx importers come with M4 and M6" comment goes.

## Decisions

- Orchestrator: the row loop moves into `editor/imports.spec.ts` (one loop over the rows, not two copies); 3.8's Build
  text says it covers `non-literal.ts` there.
- Orchestrator: `allowJs` in the imports root tsconfig, so the `.js` / `.jsx` react rows are tested as the step asks.
- Review: the error goes to the last `.ucf` import before it, not to any import whose call holds it (a nested
  `import()` took its inner import's error); fixture `rewrite-edges/nested-dynamic.js`, its core rewrite snapshot,
  a `seams.spec.ts` case.
- Review: the `.ucf` guard is `importer.block`, pinned by `react/errors/AttrNoJsx.ucf` (no JSX, so the block also parses
  as plain TypeScript; its `react.spec.ts` row: `framework-in-block`) in `seams.spec.ts`.
- Review: an unsaved syntax error in `non-literal.ts` gives `no-target` (no rewrite error) in `imports.spec.ts`.
- Review: `tsLocation(source, offset)` lives in `editor/lib/tsserver.ts` beside `offsetAt`; `imports.spec.ts` uses its
  `Component` type. The rows stay in `editor/imports.spec.ts` (orchestrator: the step's Test line names that file).
- Found while building: `importer.jsx` beside `importer.tsx` is never in a TypeScript project; renamed
  `jsx-importer.jsx` here (the 3.2 fixture list in the m3 doc says why).

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`): child processes only, no new infra.

`packages/e2e/editor/imports.spec.ts` (area: editor). One real tsserver, `cwd` `fixtures/apps/imports`, our plugin,
every importer of every `EXPECTED_IMPORTS` row open except `.vue` / `.svelte` files (M4, M6) and `src/mixed.ts`.
Per row:

- `projectInfo` of the file names its sub-project's nearest `tsconfig.json` (options come from that entry; fails
  without `allowJs`).
- react rows (attribute, importer, default, block rules; `.ts`, `.tsx`, `.js`, `.jsx`, `.ucf`): no diagnostic on the
  line; `definition` on the specifier gives `[Card.ucf]`.
- vue / svelte picks: exactly one `target-not-built` at the specifier, naming the rule (the 2.9 check, moved).
- error rows: exactly one diagnostic on the line, the row's code, `source: 'multifront'`, `category: 'error'`, at the
  specifier; for `framework-attribute-not-literal` at the start of `rewriteImportAttributes(source, file).errors[0]`,
  with that error's message as text.
- Unsaved edit (`updateOpen`, reverted after): `non-literal.ts` turned into `const options = {with: {framework}};` +
  `import(…, options)`: one `framework-attribute-not-literal` with the rewrite's options message, at the rewrite's
  spot in the edited text.
- Fails without the fix: `non-literal.ts` gives `no-target` today.

- A file that does not parse: an unsaved `const = ;` appended to `non-literal.ts` gives `no-target` at the specifier.

`packages/e2e/editor/bundle.spec.ts`, "plugin pack alone": also opens `no-default/non-literal.ts` and expects the same
`framework-attribute-not-literal`: the bundled plugin now runs the rewrite through oxc-parser's wasm binding.

`packages/e2e/editor/seams.spec.ts:80`: `resolveUcfImport` on `non-literal.ts` gives `framework-attribute-not-literal`
equal to the rewrite's error and no `resolvedModule` (replaces the `no-target` pin);
`rewrite-edges/nested-dynamic.js`: only the inner `import()` gets the error; `react/errors/AttrNoJsx.ucf`:
`framework-in-block`. The other describes pass their `sourceFile`.

`tsserver.spec.ts` keeps passing after the move.

## Docs

- `docs/milestones/m3-react-and-imports.md` 3.8: Build and Test as shipped (rewrite errors through
  `resolveUcfImport`, `allowJs`, the row loop moved into `editor/imports.spec.ts` with `non-literal.ts`, the pack
  case), `- Status: done`. "Hands to later milestones", the `expected.ts` line: M4 and M6 add their editor rows in
  `editor/imports.spec.ts`. The 3.2 fixture list names `jsx-importer.jsx`.
- `docs/architecture.md:105`: the plugin also reads a non-literal attribute with `rewriteImportAttributes()`, the
  build's function.
- spec / plan: none (spec 5 already says same rules, one shared function). `publicdocs/07-errors.md` already lists
  the code without naming a host: none.

## Fuzzing

None: the milestone puts no fuzz test here, and the editor's answer comes from calling the build's own function, so a
generated-importer oracle would check the function against itself.

## Out of scope

- `.vue` / `.svelte` importer rows and vue / svelte virtual scripts (M4, M6); `mf-tsc` (M7).
- Narrowing the "one problem, one error" filter, which hides every TS error inside the import call (2.8 design).

## Done when

- `imports.spec.ts`, `tsserver.spec.ts`, `bundle.spec.ts` and `seams.spec.ts` pass; `imports.spec.ts` fails without
  the rewrite call (non-literal row) and without `allowJs` (projectInfo).
- `pnpm devx check` green; m3 doc and architecture updated; this todo in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
