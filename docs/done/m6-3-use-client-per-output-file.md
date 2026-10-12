---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.3
---

# Milestone 6.3: `"use client"` per output file

## Problem

Spec 8: a React output file whose component uses hooks or event handlers must start with `"use client"`, or Next.js App
Router renders it as a Server Component and fails. Today no library output file reliably has it:

- A `<react>` block with no directive (Counter, Button) gets none.
- A block that has one (Tooltip) loses it. Rolldown keeps it at the top of the chunk, then 6.2's `libraryCss` prepends
  `import "./Tooltip.css";` above it in `renderChunk`. Rolldown then drops the directive silently, because it is no
  longer first.

Checked (Vite 8.2.2, Rolldown 1.2.8, the fixture library, spy plugins): `"use client";` that a `renderChunk` puts first
survives; a plain `.ts` module's own directive is kept by Rolldown; Rolldown logs no directive warning, under
`preserveModules` or when a directive module is bundled into another chunk.

## Decisions

- The React target's `load` records `needsUseClient` per module id, as module meta; the library-only `renderChunk`
  reads it (orchestrator, rule 1: the step text settles it).
- No warning silencing: Rolldown emits none. The test pins "no warning at all" (orchestrator: approved).
- A core table test over new `fixtures/components/react/use-client/` files covers each detection rule (orchestrator:
  approved; the e2e fixture covers only three of the five).

## Plan

### Core: `packages/core/src/react/useClient.ts`

- `needsUseClient(code: string, filename: string): boolean`, exported from `packages/core/src/index.ts`.
- `code` is a `<react>` block's content, parsed with `parseSync(filename, code, {lang: 'tsx', sourceType: 'module'})`.
  Parse errors are ignored and the recovered program is walked: the build reports syntax errors itself.
- True when any of these holds:
  - the prologue has an `ExpressionStatement` with `directive === 'use client'`;
  - a `CallExpression` whose callee is an `Identifier`, or a non-computed `MemberExpression` property (`React.useState`),
    named `/^use[A-Z]/` (not `use()`, not `useless()`);
  - a `CallExpression` to `createContext` in the same two callee forms;
  - a `JSXAttribute` with a `JSXIdentifier` name matching `/^on[A-Z]/` and a value that is present and not a string
    (a string `Literal`, or an expression container holding one or a template literal with no expressions);
  - a `ClassDeclaration` / `ClassExpression` whose `superClass` is `Component` or `PureComponent`, as an identifier or
    a member property (`React.Component`).
- Walks with `walk()` from `packages/core/src/ast.ts`. The React names go in `packages/core/src/react/reactApis.ts`.

### Vite: the React target's `load` records it

- `packages/vite/src/plugin.ts`, `load`, the React target branch, in builds only (`command === 'build'`, so the dev
  server never parses for it): the result also carries
  `meta: {multifront: {useClient: needsUseClient(block.content, file)}}`, from the split's `<react>` block.
- The meta shape is `UcfModuleMeta` in `packages/vite/src/types.ts`; the library plugin reads it with
  `this.getModuleInfo(facade).meta.multifront`.

### Vite: `packages/vite/src/library/useClient.ts`, `libraryUseClient(): Plugin`

- `name: 'multifront:library-use-client'`, `enforce: 'post'`, added in `buildOne()`
  (`packages/vite/src/library/build.ts`) after `libraryCss(root, src)` only when the row has `useClient`, so its
  `renderChunk` runs after the CSS prepend.
- `renderChunk(code, chunk)`: `this.parse(code)`; `existing` = top-level `ExpressionStatement`s whose expression is the
  string `'use client'`, directive or not. The chunk needs it when `existing` is non-empty (a plain module or block
  that had it) or the facade module's meta says `useClient`. Not needed, or already exactly one as the first
  statement → `null`. Else MagicString: remove each `existing` statement plus its trailing newline, prepend
  `"use client";\n`, return `{code, map: generateMap({hires: 'boundary'})}`.

### Wiring

- `LibraryTarget` (`packages/vite/src/types.ts`) gains `useClient?: boolean`; `libraryTargets.react` sets it. The vue
  row has none, 6.8's svelte row none.

## Tests

No new test infrastructure: all run inside `pnpm devx test` (this host; CI's `check` job and the floor jobs).

1. Core, `packages/core/test/react/useClient.spec.ts`: real fixture files through `splitBlocks`, then
   `needsUseClient(split.targets.react.content, filename)`, one row each.
   - True: `react/UseClient.ucf`, `react/Directives.ucf`, library `Counter.ucf`, `Button.ucf`, `Tooltip.ucf`, and new
     `react/use-client/` files `ClientHook.ucf` (custom hook in a nested arrow), `ClientMemberHook.ucf`
     (`React.useState`), `ClientHandler.ucf` (`onClick={handle}`), `ClientContext.ucf` (`createContext`),
     `ClientClass.ucf` (`extends React.Component`), `ClientPureClass.ucf` (a class expression extending an imported
     `PureComponent`).
   - False: library `Card.ucf`, `Panel.ucf`, `Icon.ucf`, `Badge.ucf`, `forms/Field.ucf`; new `ServerUse.ucf`
     (`use(promise)`, `useless()`), `ServerHandlerString.ucf` (`onToggle="x"`, `onClick={'x'}`, lowercase `onclick`, a bare `onActive`).
2. Build area, `packages/e2e/build/library-use-client.spec.ts`: builds the fixture library into a fresh temp `outDir`,
   collecting every warn-level log, and reads each output JS file with oxc-parser:
   - `react/Counter.js`, `Button.js`, `Tooltip.js`: first statement the `'use client'` directive, second
     `import "./<Name>.css"`, exactly one top-level `'use client'` statement.
   - every other `react/*.js` (Card, Panel, Icon, Badge, forms/Field, `hooks/useToggle.js`, `index.js`, `utils/cx.js`,
     `_virtual/*`) and every `vue/*.js` has none.
   - source map: the `useState(0)` line of `react/Counter.js` maps to the `useState(0)` line of `Counter.ucf` with the
     real `source-map-js`.
   - the build logs no warning.
   - on a copy: `hooks/useToggle.ts` starting with `'use client';` keeps it first, once; a new `src/Clicker.ucf`
     (an `onClick`, no `<style>`) gets it first, once, and imports no CSS.
3. `packages/e2e/build/library-css.spec.ts`, "starts each component's JS with an import of its own CSS file": for the
   three React client files it expects `"use client";\n` before the CSS import line.

## Results

- Shipped the plan, with these changes:
  - The library plugin reads the module meta of the chunk's facade directly, so it does not need `componentFile()`;
    that helper stays in `css.ts`.
  - The statement type comes from Rolldown's `this.parse` (`@multifront/vite` has no `oxc-parser` dependency).
  - The review: the `load` meta is computed only in builds; `USE_CLIENT` is core's, re-exported; the string check
    reuses `literalValue` from `imports/rewrite.ts`; the e2e specs share `LIBRARY_CLIENT` and `parseOutput` from
    `build/lib/library.ts`. The suggestions to decide from `buildLibrary`'s scan (the step text says `load`), to pass
    a `Block` to `needsUseClient` (the step and M7 hand-off name `(code, filename)`) and to drop the `useClient` row
    flag (per-target differences live in the row) were declined.
  - Rolldown 1.2.8 itself drops a `"use client"` that a `renderChunk` left below an import (checked with plain
    Rolldown, no Vite). The plugin still removes it, so "never twice" does not lean on that; no test can tell the two
    apart.
- `useClient.spec.ts`: 19 cases, `library-use-client.spec.ts`: 5 cases, all green. The plugin's prepend, its source map
  and the `load` meta each make a case fail when removed (checked). `pnpm devx check` passes.

## Docs

- `docs/architecture.md`, "Build", the library-build bullet: "imports on its first line" gains "after `"use client"`
  when present", plus one sentence on `needsUseClient` and the directive. No graphic change.
- `docs/spec.md` 8 and `docs/plan.md` 6 already say this. `publicdocs/`: none (milestone docs writer).
- Milestone doc, step 6.3: the warning sentence says there is none to silence; `- Status: done`.

## Fuzzing

Not a candidate: no cheap oracle beyond determinism; the Vite side is a fixed prepend whose map test 2 checks.

## Out of scope

- `"use server"`, server actions, other directives.
- Hooks reached in unusual ways (`React['useState']`): the author adds `'use client'` in the block.
- An editor hint from `needsUseClient` (M7). The Next.js proof (6.12). Vue and Svelte output.

## Done when

- `react/Counter.js`, `Button.js`, `Tooltip.js` start with `"use client"` exactly once, then their CSS import;
  `Card.js`, `Panel.js`, `hooks/useToggle.js` do not. A plain module's own directive stays first. Counter's source map
  is still right. The build logs no warning.
- `useClient.spec.ts`, `library-use-client.spec.ts` and the updated `library-css.spec.ts` pass; `pnpm devx check`
  passes.
- `docs/architecture.md` and the milestone doc updated; todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
