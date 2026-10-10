---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.5
---

# Milestone 3.5: react.build(), the virtual module, styles and `$style`

## Problem

The react row of the registry (`packages/core/src/blocks/react.ts`) has only `check` (3.4). The Vite `load` hook (3.6)
needs the file plugin-react compiles for `/abs/Card.ucf.react.tsx`: the `<react>` block alone, with one import per
`<style>` block's CSS module and one per class map (`$style`, named modules), and a source map straight into the
`.ucf` file. A leading `"use client"` must stay first (milestone 5). No scope transform yet (3.10 to 3.12).

## Plan

### 1. `packages/core/src/blocks/react.ts`: `build(block, ctx): VirtualFile`

- `const text = new MagicString(ctx.source)` over the **whole** `.ucf` source (magic-string 1.3.1 already in core).
  `text.remove(0, block.contentStart)` and `text.remove(block.contentEnd, ctx.source.length)`: every edit uses `.ucf`
  offsets, so the map points straight into the `.ucf` file.
- Header lines, in this order:
  - one `import "<id>";` per `ctx.styles` entry (every `<style>`, module ones too, source order), id = `style.id`
    (`styleId()`, `?ucf&type=style&index=N&lang.css`);
  - one `import <name> from "<id>";` per `ctx.modules` entry (`$style`, or the `module="name"` value), id = the
    class map id (`classMapId()`). A name that is no identifier (`module="my-theme"`, regex `/^[A-Za-z_$][\w$]*$/`,
    the one language-tools uses) gets no class map import, as the editor declares none; its CSS import stays. Ids are written with `JSON.stringify`, so a quote or a Windows backslash in a
    path stays a valid string.
- Two modules with the same name: `ctx.modules` already keeps the last block (M1 1.9, as plugin-vue's
  `Object.assign` merge), so one import per name, from the last block. The warning is M1's `duplicate-style-module`
  from `style.check`, which hosts get from `checkBlocks`: nothing new here.
- Directive prologue: parse `block.content` with oxc-parser (`lang: 'tsx'`, `sourceType: 'module'`, the same call as
  `check`). Leading `program.body` statements that are `ExpressionStatement` with `directive` set (oxc gives
  `directive: 'use client'`) form the prologue.
  - Prologue present → one `text.appendLeft(block.contentStart + last.end, …)` with the header lines joined, each
    after a `\n`, so `'use client';` stays the first statement.
  - Else → one `text.prependRight(block.contentStart, …)` with the header lines joined, each followed by `\n`.
  - No style at all → no header and no parse; the code is the block content.
- Returns `{ext: '.tsx', code: text.toString(), map}`, map = `text.generateMap({source: ctx.filename, hires: true,
  includeContent: true})` copied into core's plain `SourceMap` (`{version: 3, sources, sourcesContent, names,
  mappings}`, the shape `rewrite.ts:149-151` uses). `hires: true`: 3.13's fuzz rule 2 reads the hires map.
- `reactKind` gains `build`.

### 2. `packages/core/src/types.ts`

- `BlockKind.build` comment `// style now; react in M3, vue in M4, svelte in M6` → `// style and react; vue in M4,
  svelte in M6`. No type change: `VirtualFile` already has `ext: '.tsx'` and `map: SourceMap | undefined`.

### 3. Fixtures, `packages/e2e/fixtures/components/react/`

- `AllBlocks.ucf`: `<vue>` (`<script setup lang="ts">` with a const `'all-blocks-vue-marker'`, template using
  `$style.card` and `classes.title`), `<react>` (`export default function AllBlocks()`, root
  `<div className={$style.card}>`, `<p className={classes.title}>`, `<p className="all-blocks-global">` holding the
  text `all-blocks-react-marker` for 3.6's map check), `<svelte>` (`'all-blocks-svelte-marker'`, same classes),
  `<style module>` `.card { padding: 16px; }` (3.9 checks that value), `<style module="classes">` `.title { color:
  rgb(…) }`, a global `<style>` `.all-blocks-global { … }`.
- `UseClient.ucf`: `<react>` opening with `'use client';`, then `import {useState} from 'react';`, a counter button
  using `$style.button`; one `<style module>`.
- `Directives.ucf`: two directives, the first without a `;` (`'use client'` then `'use strict';`), one `<style module>`.
- `Unicode.ucf`: `<react>` with a comment holding accents and an emoji, a `const label = 'Ünïcödé 🎉'`, and JSX
  after emoji on the same line (`<p className={$style.text}>Crème brûlée 🍮 {label} <b>énd</b></p>`); one
  `<style module>`.
- No change to the root `components/` list, so `context.spec.ts`, `split.spec.ts` and the editor lists stay as they are.

## Tests

`packages/core/test/blocks/react.spec.ts`, new `describe('react.build')`. Runs in core's vitest project: this host
and the CI `check` job (`pnpm devx test`). Needs only `@vue/compiler-sfc` (core devDependency, loaded with
`createRequire` as `context.spec.ts` does), oxc-parser and `@jridgewell/trace-mapping` (root devDependency, M1).
No new infra.

- Context: `createBuildContext(splitBlocks(...), {root: FIXTURES_DIR, compiler, production: true})`, then
  `react.check` gives `[]` and `react.build(split.targets.react!, ctx)`.
- Rows written by hand: every `react/` fixture (`AllBlocks`, `Directives`, `Unicode`, `UseClient`), plus
  `invalid/DuplicateStyleModule.ucf` (last-wins case: five CSS imports, `$style` from index 4, `classes` from 1),
  `Hello.ucf` (no `<style>`: no header) and `editor/StyleModuleEdges.ucf` (`module="my-theme"`: no class map import).
  Each row: the CSS indexes, the module name → block index map, three tokens with their `.ucf` line and column.
  `listComponents('react')` must equal the `react/` rows (a new fixture there needs a row).
- Per row:
  - `ext` is `'.tsx'`;
  - snapshot of `code` per fixture, `__snapshots__/react/build/<fixture path>.tsx.snap` (for example
    `react/AllBlocks.ucf.tsx.snap`) (plain text, kept out of tsc,
    oxlint and oxfmt), with `FIXTURES_DIR` replaced by `<fixtures>`;
  - the output parses with oxc-parser (`lang: 'tsx'`) with zero errors;
  - its imports from our ids are exactly the row's: `import "<styleId(file, i)>"` per CSS index, in order, then
    `import <name> from "<classMapId(file, index)>"` per module;
  - removing those import declarations (and their newline) gives exactly `block.content`: nothing else was added,
    and no text of the `<vue>` or `<svelte>` block is in it. Plus a direct check: no line unique to those blocks
    (AllBlocks' markers) appears in the code;
  - the row's directives are the first statements, every injected import comes after them (`UseClient`,
    `Directives`);
  - map: `sources` is `[filename]`, `sourcesContent` `[source]`; each token, found once in the output, maps back
    through `TraceMap` / `originalPositionFor` to its hand-written line and column, which the test also checks
    against the token's offset in the source (Unicode's tokens sit after the emoji: UTF-16 columns). Every injected
    import maps to nothing.

## Docs

- `docs/spec.md` 3.5: "Emit a virtual `Card.ucf.tsx` module" names the pre-spike id. Fix to `Card.ucf.react.tsx`
  (spec 4.3, the 3.1 verdict) and add "the imports go after a leading directive such as `"use client"`". Related
  finding, own commit.
- `docs/milestones/m3-react-and-imports.md`: `- Status: done` as the last line of 3.5; step text edited if a shipped
  name or shape differs.
- `docs/architecture.md`, `docs/plan.md`: none, no structure or plan decision changes.
- `publicdocs/`: none, the docs writer covers the milestone.

## Fuzzing

None in this step. 3.13 fuzzes `react.build` output (parses, only adds, the hires map) once the scope transform exists.

## Out of scope

- The scope transform: stamping (3.10), forwarding and the helper (3.11), destructured props (3.12).
- The Vite `resolveId` / `load` and `buildTarget` (3.6). No new export from core: hosts reach it through
  `getBlockKind('react').build`.

## Decisions

- Ids written with `JSON.stringify` (double quotes): a quote or a Windows backslash in a path stays valid.
- Header order: CSS imports first, then class maps, as the step text lists them.
- Snapshot as a plain `.tsx.snap` file: keeps it out of tsc, oxlint and oxfmt.
- Review: a reserved word as a module name (`module="class"`) is left as is: the editor lets it through too, and the
  block cannot name it either. `prologueEnd` stays its own function (it names the loop). The `invalid/` row keeps its
  snapshot (no `skipIf` in the repo).

## Done when

- `react.build` returns the `.tsx` virtual file with style imports, class map imports, directive kept first, exact map.
- The three fixtures exist; `react.spec.ts` covers every row; `pnpm devx check` passes.
- Spec 3.5 names `Card.ucf.react.tsx`; milestone 3.5 ends with `- Status: done`; this todo moved to `docs/done/`
  matching what shipped.
- The review ran and its findings are fixed.
- The simplify-comments pass ran on every touched source file, committed on its own.
