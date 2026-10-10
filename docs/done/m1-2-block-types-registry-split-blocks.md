---
type: feature
spec: full-plan
status: done
created: 2026-10-09
milestone: 1
step: 1.2
---

# Milestone 1.2: block types, the registry and splitBlocks for valid files

## Problem

Core has only `Target`, `TARGETS` and `isTarget()`. Every later step (1.3 errors, 1.4 checks, 1.5 fuzz, 1.6 grammar,
1.8/1.9 styles, the exit test) and milestones 2 to 7 need the block types, the `BlockKind` registry and a splitter that
turns a `.ucf` file into root blocks with exact offsets. The shared `.ucf` fixtures and their helpers do not exist yet.

## Plan

1. **Types** in `packages/core/src/types.ts` (next to `Target`), final shapes from the milestone doc:
   - `BlockTag = 'style' | Target`, `BlockRole = 'shared' | 'target'`.
   - `Block` {`type`, `attrs: Record<string, string | true>`, `content`, `start`, `end`, `contentStart`,
     `contentEnd`, `index`}.
   - `SplitResult` {`filename`, `source`, `blocks`, `styles`, `targets: Partial<Record<Target, Block>>`,
     `errors: Diagnostic[]`}.
   - `BlockKind` {`tag: BlockTag`, `role: BlockRole`}: only these two in this step (1.4, 1.6, 1.9 add the rest).
   - `Diagnostic` and `DiagnosticCode` as written in 1.3 (the whole union): `SplitResult.errors` cannot type-check
     without them. In 1.2 `errors` is always `[]`. 1.3's step text is edited to say the type exists.
2. **Registry** `packages/core/src/blocks/`:
   - `style.ts`: `styleKind: BlockKind = {tag: 'style', role: 'shared'}`.
   - `vue.ts`, `react.ts`, `svelte.ts`: `vueKind`, `reactKind`, `svelteKind`, `role: 'target'`.
   - `index.ts`: a `Record<BlockTag, BlockKind>` in registry order (shared first, then `TARGETS` order);
     `BLOCK_KINDS: readonly BlockKind[]` is its `Object.values`, so a kind cannot sit in one and miss the other;
     `getBlockKind(tag)` reads the record, so no "not found" branch.
3. **`packages/core/src/split.ts`**, `splitBlocks(source: string, filename: string): SplitResult`, a hand-written
   scanner over offsets:
   - Root tags: a `Set` of `BLOCK_KINDS` tags; a new kind adds a root tag with no splitter change.
   - Gap loop: skip whitespace; skip `<!--` to after `-->` (an unclosed comment is stray text); `<` + an ASCII letter
     starts a tag whose name runs to whitespace, `/` or `>` (HTML rule, so `<react_old>` is one unknown tag); a root
     tag name opens a block.
   - Opening tag: after the name, loop until `>`: skip whitespace and a lone `/`, read an attribute name (up to
     whitespace, `=`, `>`, `/`), then optional `=` (spaces allowed) and a value `"…"`, `'…'` or unquoted (up to
     whitespace or `>`). Bare name → `true`; repeated name: last wins; values kept raw (no entity decoding).
   - An opening tag that never ends cleanly counts as unclosed: end of file, a self-closing `/>`, or a quoted value
     with no closing quote before a `>` or a line break. Otherwise it would take the next block as its content.
   - Content: raw text from after the opening `>` to the first `</tag` followed by `>` or whitespace (browser
     `<script>` rules); the closing tag ends at the next `>`. `contentEnd` = that `<`, `end` = after that `>`.
   - `index` = count of earlier blocks of the same type; `styles` = the style blocks; `targets[t]` = first block of
     each target (kind role `target`, via `getBlockKind`; `isTarget` lives in `index.ts`, and importing it would be an
     import cycle).
   - Invalid structure: stray text, an unclosed comment or an unknown tag is skipped up to the next `<`, an unclosed
     block is left out, nothing is reported. 1.3 turns each skip into its diagnostic and makes each recovery row exact.
4. **Exports** from `packages/core/src/index.ts`: `splitBlocks`, `BLOCK_KINDS`, `getBlockKind`, types `Block`,
   `BlockTag`, `BlockRole`, `SplitResult`, `BlockKind`, `Diagnostic`, `DiagnosticCode` (the last three are also in
   1.9's export list; they come now because the exported values and types name them).
5. **Fixture helpers** in `packages/e2e/fixtures/index.ts`, next to `copyApp`:
   - `export const FIXTURES_DIR` (the existing const, exported).
   - `componentPath(name)` → `join(FIXTURES_DIR, 'components', name)`.
   - `readComponent(name)` → `{filename: componentPath(name), source: readFileSync(…, 'utf8')}`.
   - `listComponents(folder?)`: `*.ucf` files in `components/` or `components/<folder>/`, not recursive, sorted by
     code unit, with the `folder/` prefix when a folder is given.
6. **Valid fixtures** in `packages/e2e/fixtures/components/` (its `.gitkeep` goes):
   - `Card.ucf`: the spec section 2 example, verbatim.
   - `Badge.ucf`: `<react>` + `<style scoped>`.
   - `Button.ucf`: vue, react, svelte, `<style scoped>`, `<style module='classes'>` (single quotes); blocks use
     `classes.x`.
   - `Panel.ucf`: vue, react, `<style scoped lang = scss>` (unquoted, spaces around `=`; a variable and a nested
     rule), a plain `<style>` with a global rule.
   - `Hello.ucf`: `<react>` only, no style; its closing tag is `</react >`.
   - `TsxEdges.ucf`: `<react>` + `<style scoped>`; the react block holds a `<>…</>` fragment, `<T,>(x: T) => x`,
     `a < b`, `a<b && c>d`, a `'<react>'` string, a `// <style>` comment, the escaped `'<\/react>'` and a
     `'</reactive>'` string, and stays valid TSX. An HTML comment holding `<style>` sits between its two blocks.
   - Every target block exports a default component.
7. **Milestone doc**: `- Status: done` as the last line of 1.2; the 1.2 fixture table rows for Button, Panel, Hello
   and TsxEdges show the forms used; the 1.2 Exports line adds `BlockKind`, `Diagnostic`, `DiagnosticCode`; 1.3's
   Build line says `Diagnostic` exists since 1.2 and 1.3 fills `errors`, and its `unclosed-block` row covers an
   opening tag that never ends cleanly.

## Tests

`packages/core/test/split.spec.ts` (core's own test). Imports `listComponents` and `readComponent` from
`'../../e2e/fixtures/index.ts'` by relative path: no package dependency, so no workspace cycle. Runs on this host and in
CI's `check` job (`pnpm devx test`); needs only the root `typescript` 6.0.3, already installed. No new infra.

- `listComponents()` equals `['Badge.ucf', 'Button.ucf', 'Card.ucf', 'Hello.ucf', 'Panel.ucf', 'TsxEdges.ucf']`.
- Per valid fixture:
  - `errors` is `[]`; `filename` and `source` echoed.
  - Every block: `source.slice(contentStart, contentEnd) === content`; `source.slice(start, contentStart)` is
    `<type…>`; `source.slice(contentEnd, end)` matches `</type\s*>`.
  - `styles` equals the style blocks in order, `styles[i].index === i`; each `targets[t]` is the first block of type
    `t`, and the key is missing for a target with no block; `getBlockKind(block.type).tag === block.type`.
  - The block table (every `Block` field but `content`) matches
    `test/__snapshots__/split/<Name>.ucf.json` (`toMatchFileSnapshot`, committed, checked by hand).
  - Every `<react>` content: `ts.createSourceFile('Block.tsx', …, ScriptKind.TSX)`, syntax errors read through the
    public `ts.createProgram(…).getSyntacticDiagnostics(file)`: zero.
- A hand-written attribute table: Card `{module: true, lang: 'scss'}`, Button `{scoped: true}` and
  `{module: 'classes'}`, Panel `{scoped: true, lang: 'scss'}` and `{}`.

`packages/core/test/blocks/index.spec.ts` (mirrors `src/blocks/index.ts`): `BLOCK_KINDS` tags equal
`['style', ...TARGETS]`, roles `shared, target, target, target`, and `getBlockKind(kind.tag)` returns each kind.

## Docs

- `docs/spec.md` 3.2: the per-block output gets `index`.
- Milestone doc: as in Plan 7.
- `docs/architecture.md`: none (the `BlockKind` snippet changes in 1.9; "Where the code lives" already shows `blocks/`).
- `docs/plan.md`, `SETUP.md`, `publicdocs/`: none.

## Fuzzing

None here: step 1.5 is the splitter fuzz test.

## Decisions

- Invalid input in 1.2: skipped silently (same recovery path 1.3 reports on), no invalid-input tests here
  (orchestrator: option A).
- `Diagnostic` / `DiagnosticCode` move into 1.2 because `SplitResult` names them (orchestrator confirmed).
- Attribute forms covered by fixtures: Button `module='classes'`, Panel `lang=scss`; Card stays verbatim
  (orchestrator: option A).

- Review: an unclosed comment, an unclosed quote and a self-closing `<style/>` no longer swallow later blocks, and a
  tag name runs to whitespace, `/` or `>`. Invalid-input tests stay in 1.3 and 1.5, per the decision above.
- Review: fixtures now cover a comment holding `<style>`, `</react >`, `'</reactive>'` and spaces around `=`.
- Review, not taken: a repeated attribute in a fixture (Vue's parser rejects one, and 1.10 hands these blocks to
  plugin-vue); first-wins `targets` and `listComponents(folder)` get their first callers and fixtures in 1.3; the
  `createProgram` route stays, as the step text names `ts.createSourceFile(…, ScriptKind.TSX)`; the role-based
  target check stays, so a new shared kind needs no splitter change.

## Out of scope

- Diagnostics and invalid fixtures (1.3). `check`, `checkBlocks`, `oxc-parser` (1.4). Grammar (1.6).
- Style compile, scope id, build context (1.7 to 1.9).

## Done when

- `splitBlocks()` returns the right blocks, attributes and offsets for every valid fixture; `split.spec.ts` passes on
  this host and in CI.
- Exports and fixture helpers have the shapes above; the milestone step is marked done.
- `pnpm devx check` is green.
- The simplify-comments pass ran on every touched source file, committed on its own.
