---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.10
---

# Milestone 5.10: the `<svelte>` block in the language server

## Problem

Since 5.9, tsserver serves `Card.ucf.svelte.ts` (svelte2tsx's script) beside the React and Vue scripts, and requests in the `<svelte>` block already go there (`targetScripts.ts` `servedAt`, `DIAGNOSTICS`). But the script maps nothing back except the class map keys (`packages/language-tools/src/blocks/svelte.ts:20-46`, `mappings` holds only `declareModule`'s entries). So inside `<svelte>`: no error, hover, definition or completion. svelte2tsx gives a v3 source map; nothing reads it. `framework-in-block` from tsserver never reaches a `<svelte>` block either (a `TSSERVER_CODES` code, so the language server skips it, and tsserver's has no mapping).

Checked while planning (svelte2tsx 0.7.61, svelte 5.57.0):

- svelte2tsx's map is hires: one segment per copied character. Moved script text and markup expressions (`{heading}` → `heading;`, `class={x}` → `"class":x`) keep their source text; generated wrapper code is unmapped or mapped to text that differs.
- svelte2tsx reads the *renamed* block (`$style` → `__ucfStyle`, core `renameSvelteStyles`), which has no map yet. `$style` and `__ucfStyle` differ in length, so a renamed use cannot map 1:1.
- Svelte's loose parser turns an expression it cannot read (`{$style.}` mid-typing) into an `Identifier` with an empty name spanning the whole text; a script syntax error (`const x = $style.`) fails the whole parse, even loose. Then nothing is renamed today, so `$style.` while typing gets no class completions.
- `style-inside-target` in `<svelte>` already reaches the language server: `multifrontService` reports `checkBlocks`, and `invalid/StyleInSvelte.ucf` is in the 2.6 cases.

## Plan

### Core: the rename's map (`packages/core`)

- `src/types.ts:113` `SvelteStyleRename` gains `map: SourceMap` (back into the `.ucf` file, as `build()`'s).
- `src/blocks/svelte.ts:263` `renameSvelteStyles` returns `text.generateMap({source: split.filename, hires: true})` in the same shape `build()` gives (line 258). `build()` unchanged.
- Mid-typing rename (editor path only; `build()` parses strictly): `styleUses` (102) also collects the spans of empty-name `Identifier`s (loose placeholders). `renameSvelteStyles` renames class maps *lexically* inside each such span, or in the whole content when the parse throws a `CompileError`: every `$name` token not preceded by an identifier character, `$` or `.`, with `classMap(name, modules)`, as a plain use (same `localNames`). Shorthands stay AST-only.

### Converter: `packages/language-tools/src/sourceMaps.ts` (new; M7's hand-off)

- `sourceMapMappings(map, source, generated, data): CodeMapping[]`: decodes `map.mappings` (`@jridgewell/sourcemap-codec`); each segment runs to the next segment on its generated line (else to the next line start). The part where `source` and `generated` match from the two offsets maps 1:1 with `data`; neighbours contiguous on both sides merge. As built: the rest of the run maps to the point the match ended (`lengths: [0]`, `generatedLengths: [rest]`), `verification` only. svelte2tsx writes a prop `label` as `"label"` (its `"` maps to `l`), and TypeScript's error spans the quotes: Volar keeps a diagnostic only when both its ends map, so without the points the wrong-prop test got nothing. `exactMappings()` drops the points (the rename's inner mappings use it: its only mismatches are the renames).
- `composeMappings(outer, inner)`: `outer` generated ↔ intermediate, `inner` intermediate ↔ source → generated ↔ source. 1:1 mappings by interval intersection. An `outer` point goes through the `inner` mapping that holds it (a rename's start inside a rename). An `inner` mapping with `generatedLengths` (a rename) comes through whole, only when one `outer` mapping covers all of its intermediate range. `data` from `outer`.
- New dependency `@jridgewell/sourcemap-codec` 1.6.0 (core's exact pin).

### Editor half: `packages/language-tools/src/blocks/svelte.ts`

- `svelteTypes`: keeps svelte2tsx's `.map`. `outer = sourceMapMappings(script.map, renamed.code, script.code, SVELTE_FEATURES)`, generated offsets shifted by the shim reference prefix. `inner = sourceMapMappings(rename.map, split.source, renamed.code, SVELTE_FEATURES)`, plus one mapping per renamed class map use: a gap between two neighbouring `inner` mappings whose generated text is a `locals` value and whose source text is `$name` maps `$style` (6) ↔ `__ucfStyle` (10) with `generatedLengths` (hover on `$style` shows `__ucfStyle`, the milestone's risk note). `mappings = [...composeMappings(outer, inner), ...declareModule key mappings]`.
- `SVELTE_FEATURES = {verification, completion, semantic, navigation}`: no `format` (`mf-fmt` owns it), no `structure`.
- `types()` and `editor()` both carry them. No change to `typescriptPlugin.ts`, `targetScripts.ts`, `server.ts`: routing and the diagnostics proxy exist since 4.3 / 5.9.

### `check` diagnostics

Nothing new in the language server (`style-inside-target` is there). `framework-in-block` now reaches the block from tsserver (`importErrors` on `Card.ucf.svelte.ts`, now mapped), as for `<vue>`.

## Tests

All on this host and in CI (`check` job, `pnpm devx test`; `svelte-floor` reruns on svelte 5.55.6). tsserver and the language server are child processes: no new infra.

`packages/e2e/editor/svelte-block.spec.ts` (new): the real tsserver with our plugin on `fixtures/components` (inferred project options of `vue-block-features.spec.ts`), and our real language server over LSP. Every position is searched from the `<svelte>` block's `contentStart`.

- Hover on `heading` in Panel's `{heading}` shows `heading: string`; definition there lands on `heading` in `let { heading, children }`.
- `Counter.ucf` and `vue/CounterCrlf.ucf`: hover on `{count}` shows `count: number` (CRLF, and the astral `𝄞` earlier on that line).
- `Card.ucf`: no diagnostic as written; an unsaved `$style.cardd` is exactly one diagnostic, code 2551, start and end the `.ucf` range of `cardd`; completion right after `$style.` lists `card`; hover on `$style` shows `__ucfStyle`; definition on `card` lands on `.card` in `<style module>`.
- Mid-typing: unsaved `class={$style.}`, and a script line `const x = $style.`: completion after each dot lists `card`.
- Type errors in markup expressions: in Panel, `{heading.toFixed(2)}` is one 2551 (TypeScript suggests a name) at `toFixed`; `<PanelItem label={1} />` is one 2322 inside `label={1}`.
- Definition on `<PanelItem` in Panel's block lands in `PanelItem.ucf`.
- The shared fixtures with a `<svelte>` block (`Card`, `Panel`, `PanelItem`, `Counter`, `vue/CounterCrlf`, `imports/Icon`, `imports/UsesIcon`, `svelte/NoStyle`) have no tsserver diagnostic as written. A real error this finds in a fixture is fixed in its own commit.
- `svelte/imports/AttrInSvelte.ucf`: tsserver reports `framework-in-block` at its three specifiers (as for `<vue>`; `checkBlocks` reports the attribute instead); the language server none of them.
- `svelte/errors/TopLevelStyle.ucf`: the language server reports `style-inside-target` with exactly `checkBlocks`' code and range; tsserver reports nothing there.
- Mapping soundness, through `getTypesScript` (5.9 pins that it equals the served code): for every `.ucf` under `fixtures/components` with a `<svelte>` block, every mapping lies inside the block's content and its source text equals its generated text, except the class map renames (`$name` ↔ local) and the diagnostics-only points. Two files get no script: `svelte/errors/UnclosedBrace.ucf`, and `invalid/StyleInSvelte.ucf`, whose `'<style>'` script string svelte2tsx reads as a tag (since 5.9).

Existing tests stay green, including `svelte-types.spec.ts`, `imports.spec.ts`, `bundle.spec.ts` (the converter's dependency is bundled) and core's `svelte.spec.ts` (`build()` output unchanged).

## Docs

- `docs/milestones/m5-svelte-target.md`: 5.10 text to what shipped (converter name, composed rename map, `$style` mapped whole, mid-typing rename), `- Status: done`; "Hands to later milestones": M7's converter line names `sourceMapMappings(map, source, generated, data)` in `src/sourceMaps.ts`, M6's `renameSvelteStyles` line its map.
- `docs/architecture.md:107`: one sentence: the `<svelte>` code's mappings are svelte2tsx's source map composed with the rename's.
- `publicdocs/05-editor-setup.md`: `<svelte>` gets its own row (highlighting, completions in scripts and `{…}` expressions, errors, hover, go to definition, also across `.ts` files, with `svelte` installed); `<style lang="less">` keeps "Highlighting". One line in "Typed Class Names": `$style` is typed in `<svelte>` too.
- spec, plan: none (spec 261 already says "types through svelte2tsx, markup completions later").

## Decisions

From the orchestrator:

- Plan approved.
- Q1: the lexical rename inside unreadable spans (editor path only), both typing cases tested. The step's Test reads as the typing case, and `$style.` completes while typing in `<vue>` and `<react>` (rule 2: do what Vue does).
- Q2: `svelte-parse-error` and `missing-style-module` in the editor are out of scope, nothing filed: M7 owns them (rule 1, "Hands to later milestones").
- Q3: no fuzz test (rule 3: the step does not ask for one).

While building: the diagnostics-only points of the converter (see Plan), needed by the wrong-prop test.

## Fuzzing

None (Q3). The soundness check above runs over every real Svelte fixture.

## Out of scope

- Markup completions (tags, attributes, component props): milestone 7.
- `svelte-parse-error` and `missing-style-module` in the editor: milestone 7 ("Hands to later milestones": "Diagnostic codes `svelte-parse-error` and `missing-style-module`").
- Rename and find references inside `<svelte>`: not tested, not claimed in docs.
- Keeping the last good types while markup does not parse.

## Done when

- Errors, hover, definition and script / expression completions work inside `<svelte>` at exact `.ucf` positions in tsserver.
- Every test above passes; `pnpm devx check` is green.
- Docs updated; 5.10 ends with `- Status: done`; this todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
