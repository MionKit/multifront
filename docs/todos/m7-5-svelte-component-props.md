---
type: feature
spec: full-plan
status: ready
created: 2026-10-15
milestone: 7
step: 7.5
---

# Svelte component props in markup

## Problem

In the `<svelte>` markup, `<Icon |` completes nothing from TypeScript. The server's HTML service lists HTML global
attributes and directives there instead (`class`, `onclick`, `class:`), and Svelte rejects or ignores most of those on
a component.

svelte2tsx already writes each component use as
`{ const $$_nocI0C = __sveltets_2_ensureComponent(Icon); new $$_nocI0C({ target: __sveltets_2_any(), props: {…}}); }`.
TypeScript completes the props object there: at `props: {|`, with an `Icon` typed
`Component<{name: string; size?: number}>`, plain TS lists exactly `name` and `size` (`(property) name: string`,
`(property) size?: number | undefined`). It also leaves out a prop the tag already has: `props: {| "name":…}` lists
`size` only. Our mappings never point there. `sourceMapMappings()` (`mappings.ts:57`) turns svelte2tsx's tag-end points
into zero-length, diagnostics-only points, so Volar's `getCompletionsAtPosition` (`isCompletionEnabled`) finds no
mapping in a start tag's whitespace.

Checked before planning:

- svelte2tsx 0.7.61 with Svelte 5.57.0, loose parse (`emitOnTemplateError`): `<Icon ` left unclosed, then a newline and
  more markup (what VS Code holds: it does not auto-close `<`), still gives the component and its `props: {` (plus a
  `children` prop from the markup after it).
- `@volar/source-map` `translateOffset`: a mapping with `lengths: [n]` and `generatedLengths: [0]` sends every offset of
  the source run to the one generated point.
- tsserver's diagnostics already map the unknown prop: plain TS gives TS2353 on `"nme"` and TS2741 (`name` missing) for
  `<Icon nme="x"/>`. `svelte-root-props.spec.ts` pins TS2353 on a root's unknown prop the same way.
- Hybrid mode (milestones README): tsserver with our plugin does every TypeScript job. So the prop items and the TS2353
  come from tsserver, as `{ti}` did in 7.4. Our language server never hosts TypeScript (`server.ts:131`).

## Decisions

Answers from the run-milestone orchestrator:

1. Component start tags in our HTML service keep only `bind:` and `bind:this`: 7.4's rule is that every item is valid
   Svelte where it lands, and `class:` / `use:` on a component break it; `bind:` is valid there and tsserver does not
   offer it. The 7.5 Build line names the filter.
2. No fuzz test: 7.5's Test line asks for none, and case 4 keeps the parse check.
3. The props list and the TS2353 are tested through tsserver with our plugin (hybrid mode, milestones README), our
   server for its filtered list. The 7.5 Test line says so.

## Plan

1. `packages/language-tools/src/svelteMarkup.ts` `scanMarkup()` also returns `tags`: every start tag, complete or still
   being typed. The type goes in `types.ts`: `MarkupTag {name: string; start: number; end: number; gaps: MarkupSpan[]}`.
   `MarkupScan` gains `tags: MarkupTag[]`. `gaps` holds the whitespace runs at the tag's own level: between the name
   and the first attribute, between attributes, and before `>` / `/>` (or, in an unclosed tag, up to the next `<` or
   the end). Quoted values and `{…}` are not gaps. `readTag()` records them on the `pos++` path it already walks.
   `isComponent(name)` (a capital first letter or a dot) moves here from `svelteMarkupService.ts:21`, exported.
2. `packages/language-tools/src/blocks/svelte.ts` `svelteTypes()` adds `propsMappings(block, code, mappings)`. It runs
   on the final code, after the `declareModule` loop, which only appends. For each component tag in
   `scanMarkup(block.content).tags`:
   - it finds the generated offset of the tag name (`.ucf` offset `contentStart + start + 1`) through the composed 1:1
     mappings;
   - then the first `props: {` after it, with no other `__sveltets_2_ensureComponent(` in between.
   - Each gap maps to the point right after that `{`:
     `{sourceOffsets: [contentStart + gap.start + 1], generatedOffsets: [point], lengths: [gap.end - gap.start - 1], generatedLengths: [0], data: {completion: true}}`
     (`PROPS_FEATURES`, completion only).
   - The gap's first character is left out, so `<Icon|` stays a tag-name position.
   - A tag whose name or props object is not found gets no mapping.

   This changes no diagnostics: mf-tsc, the declarations emit and tsserver read `verification` only.
3. `packages/language-tools/src/svelteMarkupService.ts` `svelteHtmlService()`. An attribute item whose start tag (the
   last `scan.tags` entry starting before the edit) is a component keeps only `bind:` and `bind:this`. Those are valid
   on a component (a prop binding, the instance). Every other HTML attribute, directive and `on*` item is dropped: the
   tag's props come from tsserver.
4. The `<Icon |` completions reach VS Code through tsserver, routed to `Toolbar.ucf.svelte.ts` by `targetScripts.ts`
   `route()`. No server or plugin wiring changes.

## Tests

All on this host and in CI's `check` job (`pnpm devx test`), area Editor, real child processes only (the real language
server over LSP, the real tsserver with our plugin). No new infra: 7.4's harness covers it.

- Fixtures in `packages/e2e/fixtures/apps/svelte-markup/`:
  - New `Icon.ucf`: a `<svelte>` block, a TS script with
    `let {name, size = 16}: {name: string; size?: number} = $props()`, markup `<span …>{name}</span>`.
  - `Toolbar.ucf` imports it (`import Icon from './Icon.ucf'`) and uses `<Icon name="search" />` after the `<input>`.
    No anchor the 7.4 spec types after moves.
- `packages/e2e/editor/lib/markup.ts` (new): 7.4's `completeIn` / `complete` (built over a server and a component),
  `labels`, `newText`, `fillSnippet`, `applyCompletion`, `expectEveryItemParses` (real `svelte/compiler` `parse`,
  modern), moved from `server/svelte-markup.spec.ts`, which then imports them. Its cases stay as they are.
- `packages/e2e/editor/server/svelte-props.spec.ts` (new). Each case is a real unsaved edit, reverted after. Through
  tsserver with our plugin (`completionInfo`, `completionEntryDetails`, diagnostics) on `Toolbar.ucf`, with
  inferred-project options as in 7.4:
  1. As written: no diagnostic on `Toolbar.ucf` (the `.ucf` import resolves to `Icon.ucf`'s Svelte script).
  2. `<Icon |` typed unclosed, then a newline and the rest of the markup: the entries are exactly `name` and `size`.
     Their details read `(property) name: string` and `(property) size?: number | undefined`.
  3. `<Icon | />`: the same two. `<Icon name="x" | />`: `size` only. `<Icon\n      |\n    />`: both.
  4. Each item of case 3's `<Icon | />` list, applied as VS Code applies it (its `replacementSpan`, else the list's
     `optionalReplacementSpan`, else at the cursor; `insertText` or the name), leaves a block the real
     `svelte/compiler` `parse` accepts.
  5. Not props: `<Icon|` (cursor on the name) and `<input | />` (a plain element) list neither `name` nor `size`.
  6. `<Icon nme="x"/>`: exactly a TS2353 starting at `nme` and inside `nme="x"`, and a TS2741 (`name` missing) inside
     the tag, the exact ranges pinned. Reverting the edit leaves no diagnostic.

  Through the real language server:

  7. `<Icon | />` lists exactly `bind:` and `bind:this`, and each parses (`expectEveryItemParses`). `<input bi| />`
     keeps 7.4's list (not narrowed).
  8. The server logged no warning or error.
- The other editor specs stay green: `svelte-markup`, `svelte-*`, `virtualCode` (component-free fixtures are unchanged;
  fixtures with components gain only completion mappings, not snapshotted), `tsc/*`, `bundle`, `vsix`.

## Docs

- `docs/spec.md` section 6, "Order" item 5: markup completions also give a component's props after `<Icon `, from
  tsserver with our plugin.
- `docs/architecture.md` "Inside a `.ucf` file": one sentence. A component start tag's whitespace maps to the props
  object svelte2tsx writes for it, completion only, and the HTML service keeps only `bind:` / `bind:this` there. No
  graphic change.
- `publicdocs/05-editor-setup.md`, the `<svelte>` row: "component props after `<Icon `".
- Milestone doc step 7.5: Build and Test lines match what shipped (tsserver in hybrid mode for the props and TS2353,
  the gap mapping, the HTML filter, the exact cases), `- Status: done`.

## Fuzzing

None. The only cheap oracle is the parse check, already in the test (case 4). A fuzz case would need a tsserver round
trip per generated tag.

## Out of scope

- Prop items as `name={$1}` snippets (TS entries insert the bare name).
- Completion while typing a prop name (`<Icon na|`), in a prop value, or of events / `let:`.
- `<svelte:component>` / `<svelte:self>` props.
- Hover on props.

## Done when

- `pnpm devx check` green, with `svelte-props.spec.ts` and the moved helpers running.
- The docs above updated, step 7.5 `- Status: done`, this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
