---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.2
---

# Milestone 4.2: `vueSfcCode()` in core

## Problem

The Vue target (plugin-vue in the build, 4.4; `@vue/language-core` in the editor, 4.3 and 4.12; `mf-lint` / `mf-fmt`
in M7) needs the `.ucf` file as plain SFC code of the same length, so every position is the same and the map is a
shift of zero. Today `packages/core/src/blocks/vue.ts` holds only `vueKind` with `check`; there is no `build` and no
SFC code. `splitBlocks()` (`packages/core/src/split.ts`) already gives every block's `start` / `contentStart` /
`contentEnd` / `end` as UTF-16 offsets. The shared fixtures are not ready: `Counter.ucf`'s `<vue>` block has only a
template, `imports/Icon.ucf` has no `<vue>` block, and `imports/ReactOnly.ucf`, `vue/CounterCrlf.ucf`, `vue/VBind.ucf`
do not exist.

## Plan

### 1. `vueSfcCode()` in `packages/core/src/blocks/vue.ts`

`export function vueSfcCode(source: string, blocks: Block[], filename: string): {code: string; map: SourceMap}`.

- One `MagicString` over the whole source. The `<vue>` block = the first block of type `vue` (a duplicate is the
  splitter's `duplicate-target` and is blanked like any other target).
- `<vue>` block: only its opening tag (`start..contentStart`, attributes included) and closing tag
  (`contentEnd..end`) are blanked.
- Every other target block (`isTarget(block.type)`, from `targets.ts`; not `getBlockKind`, which would be a circular
  import with `blocks/index.ts`) is blanked whole, tags included.
- Root `<style>` blocks, whitespace and `<!-- -->` comments between blocks stay unchanged.
- Blanking: each run of non-`\r` / `\n` characters in a range → `text.overwrite(runStart, runEnd, ' '.repeat(len))`.
  Lengths are UTF-16 code units (`String.length`), so a two-unit character becomes two spaces. Line breaks are never
  overwritten: they stay original chars, so the hires map's lines stay exact, in CRLF too.
- Map like the React build (`blocks/react.ts`): `generateMap({source: filename, hires: true, includeContent: true})`,
  returned as `{version: 3, sources, sourcesContent, names, mappings}`.
- Core still imports no compiler: only `magic-string` (already a core dependency).

A file with no `<vue>` block gets code that is only blanks plus its styles; compiler-sfc's own "At least one
`<template>` or `<script>` is required" is the callers' concern (4.3's `vue-empty-block`, 4.10).

### 2. Export

`packages/core/src/index.ts`: `export {vueSfcCode} from './blocks/vue.ts';`

### 3. Fixtures (`packages/e2e/fixtures/components/`)

- `Counter.ucf`: `<vue>` filled to mirror `<react>`: `<script setup lang="ts">` with `import { ref } from 'vue'`,
  `const props = defineProps<{start?: number}>()`, `const count = ref(props.start ?? 0)`; template
  `<div class="counter">` > `<span class="label">Clicks</span>` +
  `<button :class="$style.button" title="Zähler 𝄞" @click="count++">{{ count }}</button>`. The `<react>` button
  gains the same `title="Zähler 𝄞"`, so the non-ASCII (two-unit) text sits in the kept and the blanked region and
  both targets still render the same. Strings other tests edit stay exactly as they are.
- `vue/CounterCrlf.ucf` (new): `Counter.ucf` with `\n` → `\r\n`. `.gitattributes` (new: that path and its React
  scope snapshot `-text`) and an `.editorconfig` section (`end_of_line = crlf`) keep it CRLF.
- `vue/VBind.ucf` (new): `<vue>` with `<script setup lang="ts">` (`const color = ref('rgb(10, 120, 60)')`) and
  `<p class="bound">Bound</p>`, plus `<style scoped>` `.bound { color: v-bind(color); }`. Vue only (spec 2).
- `imports/Icon.ucf`: gains a `<vue>` block first, the same markup as its React block, with
  `aria-label="icon-vue-marker"`.
- `imports/ReactOnly.ucf` (new): a `<react>` block only, mirror of `VueOnly.ucf`.

### 4. Existing tests the fixtures feed

- Counter's positions and scope id change: core `split` / `styles` / `react/scope` snapshots, e2e
  `editor/__snapshots__/virtualCode/Counter.ucf.*` and the grammar token snapshots are updated in this PR, each diff
  read: only positions, scope ids and the new fixture text change.
- `packages/e2e/build/react-target.spec.ts`: `OTHER_MARKERS` gains `'icon-vue-marker'`.
- `packages/core/test/react/scope.spec.ts` lists every fixture with a `<react>` block and a scoped style, so its
  `SCOPED` table gains `vue/CounterCrlf.ucf` (found while building): the React build of the CRLF copy gets its own
  code snapshot, equal to Counter's but for line breaks, file path and scope id.

### 5. Milestone doc

4.2 ends with `- Status: done`. The signature with `filename` goes into the 4.2 Build line, 4.3's `build(block, ctx)`
line and "Hands to later milestones". No other milestone doc names `vueSfcCode`.

## Tests

`packages/core/test/blocks/vue.spec.ts`, real fixtures through the real `@vue/compiler-sfc` `parse()`
(`loadVueCompiler(import.meta.dirname)`) and `@jridgewell/trace-mapping` (root devDependency).

Rows: `Counter.ucf`, `vue/CounterCrlf.ucf`, `vue/VBind.ucf`, `imports/Icon.ucf`, `Card.ucf` (only fixture with a
`<svelte>` block to blank, and `lang="scss"`). Each row:

- `code.length === source.length`; `\r` / `\n` at the same offsets;
- the `<vue>` content and every `<style>` block byte-identical at the same offsets; the `<vue>` tags and every other
  target block only spaces and line breaks;
- `parse(code)`: no errors; a template whose `loc.start.line` is the `<template` line in the `.ucf` file; script setup
  as the row says; `descriptor.styles` attrs equal the splitter's `split.styles` attrs; no `customBlocks`; `cssVars`
  as the row says (`['color']` for VBind);
- map: spots traced with `originalPositionFor` land on the same `.ucf` line and column, `source === filename`
  (Counter and its CRLF copy: `{{ count }}`, `const count`, `padding`; others: one template spot).

Plus: `CounterCrlf.ucf` equals `Counter.ucf` with CRLF (no drift); `Counter.ucf`'s `<react>` block holds a two-unit
character (the guard can't be edited away silently); `imports/ReactOnly.ucf` gives only blanks, the same length, no
template / script / styles, and compiler-sfc's "At least one `<template>` or `<script>` is required" error.

Runs in `pnpm devx test` on this host and in CI (`check`, `react-floor`). No new infra.

## Docs

- `docs/milestones/m4-vue-target.md`: as in plan step 5.
- `docs/spec.md` 3.4: the "offset-shift" source map bullet says the SFC code has the file's exact length and line
  breaks, so positions are 1:1 (a shift of zero), matching the M4 Goal.
- `docs/architecture.md`, `docs/plan.md`, publicdocs: no change (architecture already describes the `<vue>` row as
  plain SFC code with the raw `<style>` blocks; no public page covers the Vue target yet).

## Fuzzing

None (decision 2).

## Out of scope

- `vueKind.build`, `vue-empty-block` and the editor half (4.3; its `vueBlock` naming stays 4.3's call).
- Any Vite / plugin-vue wiring (4.4+), `UsesIcon.ucf`'s `<vue>` block (4.10), a `size` prop on Icon (4.12).

## Done when

- `vueSfcCode` exported from `@multifront/core`; `packages/core/test/blocks/vue.spec.ts` passes on every fixture above.
- Snapshot diffs hold only position, scope id and fixture text changes.
- Milestone doc 4.2 `- Status: done`, its text matching what shipped. `pnpm devx check` passes.
- This todo in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Decisions

- Map file name: a third argument, `vueSfcCode(source, blocks, filename)` (orchestrator: compiler-sfc's `parse()`
  takes the file name for its map's `sources`, the React build does the same; smallest change to the documented shape).
- No fuzz test (orchestrator: milestone Risks already names the guard, `CounterCrlf.ucf` and the non-ASCII string).
