---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.7
---

# Milestone 5.7: Scope stamping fuzz (generated real files)

## Problem

5.2 stamps `data-v-<id>=""` on every element and component of a `<svelte>` block and renames `$style` to
`__ucfStyle`; 20 hand-written shapes (`fixtures/components/svelte/shapes/`) pin it. Nothing tries the shapes combined:
nested at random depth, with tricky text, in runes and legacy mode, with every script layout. That is where a missed
node type, a stamp in the wrong place or a broken rename would show. Spec 3.5.1 and the milestones README ("pinned by
browser tests in each framework and by fuzz tests") ask for a Svelte fuzz; 5.8 adds a forwarding rule to it.

Checked on this host (svelte 5.57.0):

- `<slot>`, `<svelte:self>`, `<svelte:component>` compile in runes mode (deprecation warnings only); `<slot>` beside
  `{@render}` is an error (`slot_snippet_conflict`).
- `<p><div>` written directly is a parse error, through `{#if}` only a warning. `<svelte:head>` inside a block or twice
  is an error. A doubled attribute is an error (`attribute_duplicate`): "add one stamp twice" must break the *compiled*
  code.
- A plain `.svelte` file reproduces our rename with Svelte's own semantics: with `const style = readable(classes)`,
  `$style.x`, `{$style}` in an object and `<C {$style} />` all render the class map. Not in `<script module>`: Svelte
  forbids store subscriptions there.
- Svelte's SSR `head` opens with `<!--hash(filename)-->` (`SvelteHead.js`): two files with the same block differ there,
  the body is the same.
- plugin-svelte 7.3.0's `vite-plugin-svelte:compile` has no `enforce`: a `pre` transform runs before it, `post` after.

## Decisions

- 300 runs by default. Planned at 200 (each run is a real SSR Vite build, four CI jobs run every test), to be raised to
  300 only if the measured time allowed: 200 runs took 6.5 s on this host (6 SSR builds), the whole spec 35 s.
- The plain `.svelte` file differs from the block only by a store header at the top of its instance script (added when
  missing): `import {readable} from 'svelte/store'`, an import of the `.ucf` file's class map module
  (`classMapId(file, 0)`) and `const style = readable(<that import>)`. Why: Svelte's own `$store` subscription is the
  closest real-Svelte meaning of `$style`, and the shared class map makes class names equal by construction, so the
  oracle judges only our stamps and our rename. So the generator never puts `$style` in `<script module>`
  (5.2's `BothScripts` / `ModuleScriptOnly` tests keep that case).
- Before comparing, Svelte's head key comment (`<!--[0-9a-z]+-->`) is replaced by `<!--head-->` in both HTMLs.
- Cases render from an SSR `vite.build` per batch of cases (one entry per batch), not one build per case.
- File names: the spec `packages/e2e/build/svelte-scope.fuzz.spec.ts` (milestone name), the generator
  `packages/e2e/build/lib/svelteScopeFuzz.ts` beside M3's `scopeFuzz.ts`.
- A real failure the fuzz finds is fixed in this PR, own commit, its shrunk input a `svelte/shapes/` fixture.

## Plan

### `packages/e2e/build/lib/svelteScopeFuzz.ts` (generator, M3's `scopeFuzz.ts` pattern)

Harvest once at load, from every `svelte/shapes/*.ucf` (`splitBlocks`, then `svelte/compiler`
`parse(content, {modern: true})`):

- **Props**: each property of `let {…} = $props()` and each `export let`, as source text (`label = 'Hello'`, `Child`),
  deduplicated by name (first fixture in sorted order wins). Type annotations dropped.
- **Statements**: the other top-level instance statements (imports, `const` / `let`) as text, with declared names, free
  names and a `runes` flag (`$state`, `$derived`); module script statements without `$style` (`export const greeting`).
  A name collision drops the later one, as M3's `addHeader`.
- **Header snippets**: top-level `{#snippet}` blocks (`extra`, `item`), always written at the top of the markup.
- **Specials**: `<svelte:head>…</svelte:head>`, `<svelte:window …/>`, `<svelte:body …/>`, `<svelte:document …/>`,
  `<svelte:options runes />` from `SpecialElements.ucf`.
- **Donors**: every `RegularElement`, `SvelteElement`, `Component`, `SvelteComponent`, `IfBlock`, `EachBlock`,
  `AwaitBlock`, `KeyBlock`, `SnippetBlock` (not a header name), `SvelteBoundary`, `RenderTag`, `SlotElement` node, as
  its source slice, kept only when its free names are all props, statements, header snippets or globals. Never a donor
  root: `SvelteSelf` (outside `{#if}` an error), `SvelteFragment` (a component's child only), anything in
  `<svelte:head>`. Free names: a walker over Svelte's AST (`{#each}` context and index, `{:then}` / `{:catch}`, snippet
  parameters, snippet names per fragment, arrow parameters, component tag roots), skipping TS type keys. A donor
  whose free name an enclosing block of its fixture binds is dropped: `{item}` of `{#each empty as item}`, moved out,
  would read the header snippet `item`.
- **Slots** per donor: before and after each child of each fragment (`fragment`, `consequent`, `alternate`, `body`,
  `fallback`, `pending`, `then`, `catch`) at any depth; none inside void elements, `<svg>`, `<title>`, `<textarea>`,
  none beside an `{:else if}` `IfBlock`. Each slot records its ancestor tags, each donor its top-level tags (through
  blocks, not components), so a `<p>`-closing tag never lands under `<p>`, nor `li` under `li`, `button` under `button`.
- **Tricky text**: `Comment` nodes, and `Text` / `ExpressionTag` nodes whose source holds `<` or `>`.
- **Style**: the shapes' `<style module scoped>` rules merged (first rule per class wins).

Model and actions (`Action<Kind>` from `fuzz.ts`; replay skips actions that no longer apply, as M3):

- A case = `legacy` (drawn per case: `export let`, no `runes` statement) + top-level pieces; a piece = a donor + the
  pieces inserted at its slots.
- `ACTION_KINDS`: `splice` (a donor into a random fitting slot, top level included: the random depth), `tricky`,
  `head`, `window`, `body`, `document` (each once, top level), `options-runes` (runes only), `module-script`.
- No `<slot>` beside `{@render}`.
- Written block: imports, props (`let {…} = $props()` or `export let …`), the statements the markup needs (closure of
  free names); module script only when needed or forced; no instance script when nothing is needed. Then header
  snippets, specials, pieces.
- `caseAt` draws `splice` 6 times and `tricky` 2 times as often as the one-off kinds, so depth comes quickly.
- Tricky text also takes an `ExpressionTag` reading a statement whose string looks like markup (`{html}`).
- `buildCase({legacy, base}, actions, {name, dir})`, `caseAt(seed, runIndex, dir)` (1 to 10 actions), `writeCase(dir, case)` (writes
  `<name>.ucf` with `<style module scoped>` and the plain `<name>.svelte`), `shapeOf(case)` (node types, mode, script
  layout, depth).

### `packages/e2e/build/svelte-scope.fuzz.spec.ts`

- `fuzzSettings({seed: 2026, runs: 300})`.
- One batch (50 cases, 10 in the negative controls): cases into `mkdtemp(join(TMP_DIR, 'svelte-fuzz', 'run-'))` with a
  copy of `svelte/shapes/Child.svelte`; `batch-N.ts` imports `render` from `svelte/server`, `Child`, each
  `./<name>.ucf` with `{ framework: 'svelte' }` and `./<name>.svelte`, and exports `renderCase(name, kind)`.
  `vite.build` (`configFile: false`, `root: dir`, silent, NODE_ENV `production`, `build: {ssr: true, write: true}`,
  plugins `[breakerPre, svelte(), multifront(), breakerPost]`), output loaded with Node `import()`.
- Build failure: the error's `id` names the module; that case leaves the batch, which builds again (no id: each case
  alone). A failing `.ucf` module counts for rule 1 only when the plain file builds alone; else the case is unusable.
- `renderCase` reads `head` and `body` inside the entry: `render()` renders lazily, on their first read, so a throw must
  happen there to be caught as a render error.
- Rules (`'builds' | 'stamps' | 'same-html'`), id from `scopeId(rootRelativePath(dir, file), source, true)`:
  1. `builds`: the `.ucf` module builds whenever the plain file builds.
  2. `stamps`: htmlparser2 in XML mode (tags as written: HTML mode adds a `<p>` for the stray `</p>` of
     `<p><h3></h3></p>`) over the `.ucf` render's `body`: every start tag carries `data-v-<id>` exactly once and no
     other `data-v-*`; `head` holds no `data-v-`.
  3. `same-html`: the `.ucf` render with every ` data-v-<id>=""` removed and the head key normalized equals the plain
     render. Plain render throws → unusable; only the `.ucf` one throws → violation.
- Runner `fuzz(settings, breakers?, onlyRule?)`: first `Failure` with `dir`, input, shrunk case, violations;
  `shrinkActions` with a `stillFails` that builds a round's candidates in one batch; shrunk files kept;
  `describeFailure` with `replayLine(seed, runIndex, SPEC_PATH)` and both shrunk sources.
- Tests:
  - `holds every rule over N generated files (seed S)`, plus a floor of usable cases set from the measured share.
  - `reaches every case`: every action, both modes, all four script layouts, depth ≥ 5, and every node type of 5.2's
    list (`RegularElement`, `SvelteElement`, `Component`, `SvelteComponent`, `SvelteSelf`, `SlotElement`,
    `SvelteFragment`, `IfBlock`, `EachBlock`, `AwaitBlock`, `KeyBlock`, `SnippetBlock`, `SvelteBoundary`, `SvelteHead`,
    `SvelteWindow`, `SvelteBody`, `SvelteDocument`, `SvelteOptions`, `Comment`).
  - Negative controls, each failing its rule with a seed, a shrunk input that still fails and a replay that regenerates
    the input: `builds` (`{#if` appended, pre); `stamps` (last stamp removed, pre; first stamp doubled in compiled
    server code, post; a stamp after `<meta` in the head, pre: not `<title>`, of which Svelte renders only the text); `same-html` (`\nbroken` appended, pre; `$style: __ucfStyle` turned
    into `__ucfStyle`, pre).

## Results

- Default run (seed 2026, 300 files): green, 199 of the first 200 cases usable (the floor is 80%).
- Long runs on this host, `MULTIFRONT_FUZZ_RUNS=2000` on seeds 1, 7 and 99: green, about 60 s each. Then
  `MULTIFRONT_FUZZ_SEED=7 MULTIFRONT_FUZZ_RUNS=10000`: green, 339 s.
- The first runs found two harness bugs, fixed before the rules counted: a donor capturing a header snippet's name
  (`{item}`), and HTML-mode parsing adding a `<p>`. No bug in the build itself.

## Tests

- The spec itself in `pnpm devx test`: this host, CI `check` and `svelte-floor` (svelte 5.55.6, plugin-svelte 7.0.0),
  which already run every e2e test. No new infra.
- Before the PR, long runs on this host (see Results).
- CI log lines showing the fuzz tests executing in `check` and `svelte-floor`, quoted.

## Docs

- `scripts/lib/env.mjs` (`MULTIFRONT_FUZZ_RUNS` description) and `.env.sample`: "300 for the scope transform and the
  Svelte scope stamping".
- `SETUP.md` fuzz paragraph names `packages/e2e/build/svelte-scope.fuzz.spec.ts`.
- Milestone 5.7: Build line names the generator path and the plain file's store header; `- Status: done`.

## Fuzzing

This step is the fuzz (fuzzy-testing skill): boundary = real Vite + plugin-svelte SSR build, then `svelte/server`.
Rules: the three above, each with a negative control; rule 1 is the "doesn't crash" floor.

## Out of scope

- The forwarding rule (5.8). `$style` in `<script module>`, `module="name"` maps, unscoped styles (5.2's tests).
- Dev server and client render (hydration is 5.6). Any core or plugin change not forced by a failing rule.

## Done when

- `svelte-scope.fuzz.spec.ts` passes on the default seed; every negative control fails its rule with a replayable seed;
  the coverage test reaches every listed fact; the long run is clean, or what it found is fixed and pinned.
- `pnpm devx check` green; CI green, the fuzz shown running in `check` and `svelte-floor`.
- Docs above updated, milestone 5.7 `- Status: done`, this spec in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
