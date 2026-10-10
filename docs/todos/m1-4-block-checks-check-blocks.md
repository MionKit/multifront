---
type: feature
spec: full-plan
status: ready
created: 2026-10-10
milestone: 1
step: 1.4
---

# Milestone 1.4: block checks, `check` per kind and `checkBlocks`

## Problem

`splitBlocks` reports structure only. Spec 2 has four block rules nobody checks yet: `<react>` must export default,
`<vue>` / `<svelte>` hold no `<style>`, `<style lang>` is a known language, and two `<style>` blocks never inject the
same module name. `BlockKind` (`packages/core/src/types.ts:32`) has only `tag` and `role`. M2 (server diagnostics),
M3 (build errors) and M7 (`mf-tsc`) need one function that returns every milestone 1 diagnostic.

## Plan

1. **Shared scanner, `packages/core/src/scan.ts`** (new). Moves `isSpace`, `isNameStart`, `tagNameEnd`,
   `readOpeningTag`, `findClosingTag` out of `split.ts:13-94` unchanged in behaviour, so kinds can reuse them without
   an import cycle (`split.ts` imports `blocks/index.ts`, which imports every kind). Their types (`OpeningTag`, the
   `broken` reason) move to `types.ts` (shared between files), not exported from `index.ts`.
   - `readOpeningTag(source, pos, inner = false)`: `inner` keeps a quoted value whose text holds `>` or a line break
     (`v-if="a > b"`, multi-line attributes) and reads an unquoted `{…}` value to its matching `}` (Svelte
     `onclick={() => x > 1}`). The root splitter keeps today's strict rule, so 1.2 / 1.3 snapshots do not move.
   - `topLevelTags(text, nests: (name: string) => boolean): {name, start, end}[]`: every opening tag at depth 0 of
     `text` (the "one level down" scanner). Skips `<!-- … -->`, and the raw text of `<script>` and `<style>` to their
     closing tag (`findClosingTag`). An opening tag whose name `nests` and that does not self-close adds one depth; a
     `</name` whose name `nests` removes one (never below 0). Stops at an opening tag that never ends.
2. **Locations, `packages/core/src/diagnostics.ts`** (new): `locate` moves from `split.ts:97`; new
   `createDiagnostic(file: Pick<SplitResult, 'filename' | 'source'>, code, start, end, message): Diagnostic`
   (`severity: 'error'`). `splitBlocks`' `report` (`split.ts:114`) calls it; checks call it with `split`.
3. **`BlockKind.check(block: Block, split: SplitResult): Diagnostic[]`** in `types.ts`, required on every kind.
4. **`blocks/react.ts`**, `react-no-default-export`: `parseSync(filename, block.content, {lang: 'tsx',
   sourceType: 'module'})` from `oxc-parser`. Parse errors → `[]` (the TSX compiler and TypeScript report those
   better). Else looks in `program.body` for an `ExportDefaultDeclaration`, or an `ExportNamedDeclaration` with a
   specifier exported as `default` (identifier or string), which covers `export {Card as default}` and
   `export {default} from './X'`. None → one error at the opening tag `[block.start, block.contentStart)`:
   `<react> has no default export; add export default to the component`.
5. **`blocks/vue.ts`**, `style-inside-target`: `topLevelTags(block.content, (name) => name === 'template')`, each
   `style` tag → one error at that opening tag, offsets shifted by `block.contentStart`:
   `<style> cannot sit inside the <vue> block; move it to the root of the file`.
6. **`blocks/svelte.ts`**, same code and message with `<svelte>`. `nests` = every element but the HTML void ones
   (`area base br col embed hr img input link meta param source track wbr`), so `<svelte:head><style>` and a
   `<style>` inside an element stay allowed, as Svelte allows them.
7. **`blocks/style.ts`**:
   - `unknown-style-lang`: `lang` present and not one of `css scss sass less styl stylus postcss` (a bare `lang` too).
     At the opening tag: `<style lang="foo"> is not a known style language; use css, scss, sass, less, styl, stylus or postcss`.
   - `duplicate-style-module`: module name = `'$style'` for a bare or empty `module` (Vue's parser reads `module=""`
     as bare), else its value. A block whose name an earlier block already injects → error at its opening tag:
     `<style module> injects $style more than once; give each module its own name`.
   - Constants and the module name helper stay private to the file (1.8 exports them if it needs them).
8. **`packages/core/src/check.ts`**: `checkBlocks(split: SplitResult): Diagnostic[]` = `split.errors` plus
   `getBlockKind(block.type).check(block, split)` for every block, stable-sorted by `start`. Exported from
   `index.ts`. It never loads a compiler (milestones README rule).
9. **Dependency**: `pnpm add oxc-parser --filter @multifront/core` → exact `dependencies` pin, the newest version
   past the 30 day `minimumReleaseAge` (today `0.149.0`, same as the `@oxc-project/types` already in the lockfile).
   No install script (napi optional bindings), so `allowBuilds` stays empty.
10. **Fixtures**, `packages/e2e/fixtures/components/`, each otherwise valid, one mistake each:
    - `ReactDefaultSpecifier.ucf`: `Card.ucf` with `function Card(…)` + `export { Card as default }`. Valid.
    - `invalid/ReactNoDefault.ucf`: `<style scoped>` first, then `<react>` with a named export only → one error at
      the `<react>` line, column 0.
    - `invalid/StyleInVue.ucf`: `<vue>` whose `<script setup>` holds a `'<style>'` string, a comment `<!-- <style> -->`,
      a `<template>` holding a nested `<template v-if="a > b">` and a `<style>` (all decoys), then an indented
      top-level `<style scoped>` → one error at that line, column 2. Plus a root `<style>`.
    - `invalid/StyleInSvelte.ucf`: `<svelte>` with a `'<style>'` string in `<script>`, `<svelte:head><style>`, a
      `<button onclick={() => count > 1}>`, then a top-level `<style>` → one error, column 2.
    - `invalid/UnknownStyleLang.ucf`: `<react>`, `<style lang="postcss">` (accepted), `<style lang="foo">` → one error.
    - `invalid/DuplicateStyleModule.ucf`: `<react>`, `<style module>`, `<style module="classes">`, `<style module>`
      → one error at the third block.
11. **Milestone doc**: `- Status: done` last line of 1.4; step text and "Hands to later milestones" edited only where
    the shipped names differ; the 1.4 Build line for `blocks/svelte.ts` names the depth rule.

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`, ubuntu x64, the `linux-x64-gnu` oxc binding comes
through the lockfile). No new infra.

- `packages/core/test/check.spec.ts` (new), fixtures through the same relative path as `split.spec.ts`:
  - every name in `listComponents()` (now 7, `ReactDefaultSpecifier.ucf` included) → `checkBlocks(split)` is `[]`;
  - hand-written table `{fixture, errors: [{code, line, column}]}` for the five new invalid fixtures, exact match;
  - every 1.3 invalid fixture → `checkBlocks(split)` equals `split.errors` (no check code on top; proves the merge,
    and that the early-cut, unparsable `<react>` of `ReactCloseInString.ucf` gets no `react-no-default-export`);
  - every result over every fixture is sorted by `start`, each diagnostic has a one-line message naming its tag, a
    range inside the file, and `line` / `column` equal to the real position of `start`;
  - each error points at the right text: `source.slice(start, end)` starts with `<react` / `<style`;
  - file snapshot of the full diagnostics per new invalid fixture, `test/__snapshots__/check/invalid/<Name>.ucf.json`
    (filename written as the fixture name), checked by hand.
- `packages/core/test/split.spec.ts`: valid list gets `ReactDefaultSpecifier.ucf` (+ its block-table snapshot);
  `INVALID_CASES` gets the five new fixtures with `errors: []` and their kept blocks (the "finds every invalid
  fixture" test lists the whole folder; this also proves the splitter accepts them).
- Fails without the step: no `checkBlocks` export, a missing rule, a decoy reported, or a wrong position.

## Docs

- `docs/spec.md` 3.2: `<react>` without `export default` leaves the splitter list; a new bullet says `checkBlocks`
  adds the block rules of section 2 (default export, no `<style>` inside `<vue>` / `<svelte>`, known `lang`, one
  module per name), same `Diagnostic` shape.
- `docs/plan.md` M1: the error list names every milestone 1 code and `checkBlocks`.
- `docs/architecture.md`: `check(block)` → `check(block, split)` in the snippet (the full snippet stays for 1.9).
- `publicdocs/`, `SETUP.md`: none (no page describes diagnostics yet).

## Fuzzing

None here: step 1.5's fuzz rules already run `checkBlocks` over generated files (never throws, positions real).

## Decisions

- Svelte "top level" = depth 0 over every non-void element; `{#…}` logic blocks are not tracked (orchestrator:
  option B; risk 4 names the leftover case).
- The new invalid fixtures join `INVALID_CASES` in `split.spec.ts` with `errors: []` (orchestrator: my pick).
- The move into `scan.ts` / `diagnostics.ts` stays behaviour-neutral: the 1.2 / 1.3 snapshots do not change
  (orchestrator).

## Out of scope

- Grammar data (1.6), compiling styles (1.8), `build` / `fillContext` (1.9), the fuzz test (1.5).
- Any change to how `splitBlocks` splits or reports.
- Exotic template cases of risk 4 (a `<style` inside a Svelte `{…}` text expression); `compiler.parse` stays a
  later option.

## Done when

- `checkBlocks()` reports every milestone 1 rule at its hand-written line and column; valid fixtures report nothing;
  `check.spec.ts` and `split.spec.ts` pass on this host and in CI.
- `pnpm devx check` is green; the milestone step is marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
