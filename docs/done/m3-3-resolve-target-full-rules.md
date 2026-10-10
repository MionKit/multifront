---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.3
---

# Milestone 3.3: resolveTarget() in core, the full rules

## Problem

Spec 4.1, 4.2 and 7 have rules M2's `resolveTarget` lacks: the `frameworks` list (a pick outside it is an error), an
import with no importer (a build entry, M5), and a way to turn a module id or virtual script name into an `Importer`
(3.6's Vite `resolveId`, M4 `.vue` sub-requests, M6 `.svelte` ids). Spec 5 says the editor and the build use this one
function, so the TypeScript plugin must read `frameworks` too.

## Plan

### 1. Core types, `packages/core/src/types.ts`

- `TargetErrorCode` (types.ts:80) gains `'target-not-enabled'` (so `DiagnosticCode` gets it too).
- `ResolveTargetOptions` (types.ts:150) gains `frameworks?: readonly Target[]` (what this build may compile; default
  all, spec 7).
- `Importer`, `TargetRule`, `TargetChoice` unchanged.

### 2. `packages/core/src/imports/resolveTarget.ts`

- Signature `resolveTarget(importer: Importer | undefined, attribute: string | undefined, options: ResolveTargetOptions = {}): TargetChoice`.
  M2's codes, messages and rule order stay.
- `importer === undefined`: skips the block and importer rules. Attribute (same `unknown-framework` check), then
  `options.framework`, else `no-target` with the message `no framework for this .ucf entry; set the framework option`.
- After a rule picks a target: not in `options.frameworks ?? TARGETS` → `target-not-enabled`, message
  `framework "svelte" is not enabled; use react, or add svelte to the frameworks option` (enabled list through
  `orList`); an empty list gives `framework "svelte" is not enabled; add it to the frameworks option`. Applies to
  every rule, block included.
- New `importerFromId(id: string): Importer`. Strips the query (from the first `?`), then:
  - path ends in `.ucf` (bare `X.ucf`, or any query: `X.ucf?vue&…`) → `{fileName: path, block: 'vue'}`. The Vue
    block keeps the real path (spec 4.3); our style and class map ids import no `.ucf` file.
  - `X.ucf.react.tsx` → react, `X.ucf.svelte.svelte` → svelte, `X.ucf.vue.ts` → vue, `X.ucf.svelte.ts` → svelte;
    `fileName` is `X.ucf`, the file on disk holding the import.
  - anything else → `{fileName: path}` (so `Page.vue?vue&type=script&setup=true&lang.ts` gets the importer rule).
- `packages/core/src/index.ts`: export `importerFromId` next to `resolveTarget`.

### 3. The TypeScript plugin reads `frameworks`, `packages/language-tools/src/resolve.ts`

- `entryOptions` (resolve.ts:100) also reads `frameworks`: an array is kept, filtered to valid targets (`isTarget`);
  anything else ignored, like `importers` today.
- Needed now: the new `react-only` row goes through `readMultifrontOptions` (`language-tools/test/resolve.spec.ts`)
  and tsserver (`e2e/editor/tsserver.spec.ts`), and both must give `target-not-enabled`.
- `resolveUcfImport` keeps building its own `Importer`: in tsserver a `.ucf` file's own script is its React script
  (`MAIN_SCRIPT_TARGET`), while `importerFromId('X.ucf')` means `<vue>` for module ids. No copy of the rules is added.

### 4. Fixtures

- `packages/e2e/fixtures/apps/imports/react-only/tsconfig.json`: `extends: "../tsconfig.json"`, `include: ["."]`,
  plugin entry `{"name": "@multifront/language-tools/typescript-plugin", "frameworks": ["react"]}`.
- `react-only/not-enabled.ts`: `import Card from '../../../components/Card.ucf' with {framework: 'svelte'};` and
  `export {Card};`.
- `expected.ts`: `REACT_ONLY: ResolveTargetOptions = {frameworks: ['react']}` and the row
  `{file: 'react-only/not-enabled.ts', specifier: CARD, line: 1, options: REACT_ONLY, expect: 'target-not-enabled'}`.
- `packages/e2e/fixtures/plugin-options/invalid-values/tsconfig.json`: adds `"frameworks": ["react", "angular", 1]`;
  the "drops values that are not a framework" test expects `frameworks: ['react']`.

## Tests

All run in `pnpm devx test` (CI `check` job, and this host). No new infra.

- `packages/core/test/imports/resolveTarget.spec.ts`, extended:
  - **Rows:** every `expected.ts` row resolves through `importerFromId(id)`: the real path for `.ts/.tsx/.jsx`, the
    script's sub-request id for `.vue` / `.svelte` (`scriptName`, with its query), and for a `.ucf` row the module id
    of the block holding the import (`X.ucf.react.tsx`), checking `importerFromId(id).block` equals the block
    `readImports` found. `pluginOptions` reads `frameworks` too; `MESSAGES` gains `'react-only/not-enabled.ts:1'`.
  - **In-block importers of `fixtures/components/Card.ucf`:** the module ids `Card.ucf`,
    `Card.ucf?vue&type=script&setup=true&lang.ts`, `Card.ucf.react.tsx`, `Card.ucf.svelte.svelte`, and the virtual
    scripts `Card.ucf.vue.ts`, `Card.ucf.svelte.ts`. Each: `importerFromId` gives `{fileName: Card.ucf, block}`; no
    attribute gives `{target: block, rule: 'block'}`; an attribute gives `framework-in-block` (hand-written message);
    with `{frameworks: ['react']}` the vue and svelte ids give `target-not-enabled` (hand-written message), react
    still block.
  - **No importer:** every row again with `importer` undefined. Rows answered by the attribute (rule `attribute`,
    `unknown-framework`, `target-not-enabled`) keep their answer; rows without an attribute give `options.framework`
    (rule `default`), else `no-target` with the entry message. `framework-in-block` and rewrite-error rows are left out.
- `packages/core/test/imports/rewrite.spec.ts`: picks up `react-only/not-enabled.ts` itself; new file snapshot
  `__snapshots__/rewrite/imports/react-only/not-enabled.ts.json`; `expectedFramework` learns the
  `target-not-enabled` row's value (`NOT_ENABLED_FRAMEWORK = 'svelte'`, like `UNKNOWN_FRAMEWORK`).
- `packages/language-tools/test/resolve.spec.ts`: the new row against its tsconfig; invalid-values covers `frameworks`.
- `packages/e2e/editor/tsserver.spec.ts`: no change; its `ROWS` filter takes `react-only/not-enabled.ts`, and a real
  tsserver must report `target-not-enabled` on the import.

## Docs

- `docs/milestones/m3-react-and-imports.md`: `- Status: done` on 3.3; the `importerFromId` bullet says "any query".
- `publicdocs/04-imports.md`: a `frameworks` row in the TypeScript plugin options table. `publicdocs/07-errors.md`:
  a `target-not-enabled` row.
- spec / plan / architecture: none; spec 4.2, 5 and 7 already describe `frameworks` and the one shared function.

## Fuzzing

None: the rules are a small table, and the rows, the in-block id list and the no-importer re-run cover every rule
and code.

## Decisions

- Orchestrator: the `frameworks` option row and the `target-not-enabled` error row go into the public docs in this PR.
- Orchestrator: any query on an `X.ucf` path maps to `<vue>`; the milestone's `importerFromId` bullet says so.
- Found while building: `orList` (`packages/core/src/diagnostics.ts`) gave `" or react"` for one item; fixed here, pinned by the `react-only` message.

## Out of scope

- Vite calling `resolveTarget` / `importerFromId` (3.6); the Vite plugin's own startup check stays.
- The TypeScript plugin's `framework-attribute-not-literal` report (3.8).
- Editor resolution for vue / svelte scripts (M4, M6).

## Done when

- Every test above passes and `pnpm devx check` is green.
- The milestone step says `- Status: done`, and this todo sits in `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
