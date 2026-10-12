---
type: feature
spec: full-plan
status: ready
created: 2026-10-12
milestone: 5
step: 5.8
---

# Milestone 5.8: Root forwarding with `{...rest}`

## Problem

5.2 stamps every element and component of a `<svelte>` block with the file's `data-v-<id>`, so a Svelte parent passes
its scope to a child as a prop (`<PanelItem data-v-panel="" />`). Nothing puts that prop on the child's root: a
parent's scoped rule never reaches a Svelte child's root, while Vue does natively and React does since M3 (3.11, 3.12).
Spec 3.5.1 requires every framework to forward the same way; spec 3.6 says Svelte does it through the props rest. This
step is part of the milestone's exit.

Checked on this host (svelte 5.57.0):

- `let { label, ...__ucfRest }: { label: string } = $props()` plus `<p data-v-own="" {...__ucfScopeAttrs(__ucfRest)}>`
  compiles with no warning; the server render with prop `data-v-parent: ''` gives
  `<p data-v-own="" data-v-parent="" class="item" …>` (attributes in source order, the spread in place).
- A top-level `__ucfWarnFragment(__ucfRest, "X")` in the instance script gives `state_referenced_locally`; the same call
  inside an arrow called at once, `;(() => __ucfWarnFragment(__ucfRest, "X"))();`, gives none. A `{__ucfWarnFragment(…)}`
  tag in markup adds a `<!---->` marker to the HTML: not used.
- Legacy mode: `__ucfWarnFragment($$props, "X")` at the top of the instance script gives no warning, also in a
  `<script>` added to a block with none (the block stays legacy).
- Svelte's runes switch (`2-analyze/index.js:454`): the compiler option, else `<svelte:options runes>`, else any
  reference to a rune (`$state`, `$props`, …). `let props = $props()` counts: a top-level `props` whose init is a rune
  call is no store. A block with no rune is legacy, even with no script at all.
- `parse(…, {modern: true})`: `root.options?.runes` is `true` / `false` / `undefined`; a script's `content.end` is right
  before `</script>`; a `<svelte:boundary>`'s `{#snippet failed}` is a `SnippetBlock` in its `fragment.nodes`.
- `compile(code, {generate: false}).metadata.runes` says whether Svelte reads a file in runes mode, without generating
  code (the fuzz oracle).

## Decisions

- **Runes mode is read from the block**, by Svelte's own rule: `<svelte:options runes={…}>` if set, else a reference to
  a rune anywhere in the block (a `$state` whose `state` is a top-level non-rune declaration is a store, not a rune). A
  block with no rune (markup only, like `svelte/NoStyle.ucf`) is legacy: it warns and does not forward. Adding
  `$props()` there would switch the component to runes mode, with it the meaning of its `let`s, and bring deprecation
  warnings for `<slot>`, `on:`, `<svelte:component>`. Core cannot see plugin-svelte's `compilerOptions.runes`: a
  project forcing runes there still needs one rune in a block (any `$props()`) for it to forward (milestone Risks).
  Orchestrator: confirmed (milestone Risks "Forwarding is runes-mode only", Out of scope "legacy-mode root forwarding").
- **Whole component**, as the step says: any branch with more than one root, or an `{#each}` root, means no forwarding
  and one warning at init. React's warning fires only on a rendered fragment root; a Svelte branch cannot warn from
  markup without changing the HTML.
- **Spread right after the stamp**, after the tag name, as React writes `data-v-x="" {...__ucfScopeAttrs(props)}`.
- **Dev-only warning**, as React: in production a non-forwarding component gets no edit at all, and the helper module
  exports only `__ucfScopeAttrs` (`scopeHelperCode(false)`).
- **Warning text** (orchestrator, Q1 = b): `__ucfWarnFragment` takes optional `problem` and `fix`; React's call and
  text stay as they are; Svelte passes "renders more than one root", "renders an {#each} block as its root", or "is a
  legacy-mode Svelte component" with "Use $props() to make it a runes-mode component."

## Plan

### Root analysis and forwarding: `packages/core/src/svelte/forward.ts` (new)

`Node`, `isNode`, `walk` move from `packages/core/src/blocks/svelte.ts:19-39` to `packages/core/src/svelte/ast.ts`,
shared by both.

- `rootsOf(fragment)`: walks branches. A branch = a list of fragment nodes. Not counted: whitespace-only `Text`,
  `Comment`, `SnippetBlock`, `DebugTag`, `SvelteHead`, `SvelteWindow`, `SvelteBody`, `SvelteDocument`. A counted node
  that is `IfBlock` → its `consequent` and `alternate` are branches (an `{:else if}` is the one `IfBlock` of
  `alternate`: recursion covers it); `KeyBlock` → its `fragment`; `AwaitBlock` → `pending`, `then`, `catch` (each may be
  `null`); `SvelteBoundary` → its non-snippet children are one branch, the body of each `{#snippet}` child (`failed`,
  `pending`) another. Any other counted node is a root. Result: the roots, plus `forwardable` = every branch has at most
  one root and no root is an `EachBlock`. Element roots: `RegularElement`, `SvelteElement`, `Component`,
  `SvelteComponent`, `SvelteSelf`. Any other root (text, `{expr}`, `{@render}`, `{@html}`, `<slot>`) gets nothing and
  no warning, as React's `null` / text / `children` roots.
- `forwardScope(text, root, block, ctx, used, runes)`, called from `build()` after the renames and `stampScope`: no
  element root anywhere → no edit. Forwardable and runes → forward. Otherwise, dev → warn; production → nothing.
  Returns the helper names to import and the lines for the instance script.
- **Props source** (instance script top-level `VariableDeclaration` whose init is a plain `$props()` call):
  `let props = $props()` → forward from `props`; `let { a, ...rest } = $props()` → reuse `rest`;
  `let { a }: T = $props()` → insert `, ...__ucfRest` after the last property (with a trailing comma: ` ...__ucfRest`
  after the comma, as a comma after a rest is a syntax error; comments skipped via `root.comments`);
  `let {} = $props()` → `{...__ucfRest}`. No `$props()` → `let __ucfRest = $props();` added to the instance script
  (an added `<script>` when the block has none). `__ucfRest` = `freshName(used, '__ucfRest')`.
- **Forward**: ` {...__ucfScopeAttrs(<props>)}` `appendLeft` at the end of each element root's name (the stamp's
  offset, so after it), mapped like the stamp.
- **Warn** (dev): runes → the props source as above, then `;(() => __ucfWarnFragment(<props>, "<Name>", …))();` as
  the instance script's last line; legacy → `;__ucfWarnFragment($$props, "<Name>", …);`. `<Name>` =
  `basename(ctx.filename, '.ucf')`, as React.
- **Runes detection**: `styleUses` (`blocks/svelte.ts:83`) already visits every identifier with the property, import,
  export and type filters; it also returns `runes` (a `$<rune>` reference that is no store), overridden by
  `root.options.runes`.

### `packages/core/src/blocks/svelte.ts` `build()` (`:173-206`)

- Imports gain `import {…} from "virtual:multifront/scope-attrs";` (`SCOPE_HELPER_ID`) when `forwardScope` returns
  helpers, placed where the class map imports go (module script, else instance, else added `<script>`).
- Instance lines (`let __ucfRest = $props();`, the warning call) go at the end of the instance script (`content.end`);
  with no instance script into an added `<script>`, which also takes the imports when there is no module script either
  (one added script, not two).

### `packages/core/src/react/scopeHelper.ts:17-27`

`__ucfWarnFragment(props, name, problem = 'renders a fragment root', fix = 'Render one root element instead.')`.

### Fixtures

- `packages/e2e/fixtures/components/svelte/roots/` (each a `<svelte>` block, `.shape` on each root,
  `<span class="inner">` inside):
  `IfElseRoot.ucf` (`{#if}` / `{:else if}` / `{:else}` roots `div` / `p` / `section`, own `<style scoped>`, trailing
  comma in `let { branch, }: { branch: string } = $props()`), `ComponentRoot.ucf` (root `<SvelteElementRoot tag="article" />`
  from `./SvelteElementRoot.ucf`), `SvelteElementRoot.ucf` (`<svelte:element this={tag}>`), `NestedRoot.ucf` (`{#key}`
  → `<svelte:boundary>` with a `{#snippet failed}` root → `{#await}` pending / then / catch roots,
  `let props = $props()`), `RestRoot.ucf` (`let { label, ...rest } = $props()` reading `rest`), `NoPropsRoot.ucf`
  (`$state`, no `$props()`), `EachRoot.ucf` and `MultiRoot.ucf` (runes, warn), `LegacyRoot.ucf` (`export let`, warns).
- `packages/e2e/fixtures/apps/all-targets/Roots.ucf` (a Svelte parent, as M3's `react-scope/Parent.ucf`): scoped
  `.shape { color: rgb(200, 40, 80) }`, each fixture (each `IfElseRoot` branch) in a `<div data-case="Name:branch">`.
  `src/main.tsx`: `?page=roots` mounts only `Roots` into `#svelte` (the default page stays free of warnings for 5.5's
  console checks), else the page as today.
- `Panel.ucf`: the `<vue>` and `<react>` blocks import `./PanelItem.ucf` and render `<PanelItem label="first item" />`
  after the `<h3>`, as the `<svelte>` block does (5.5's `<h3 className="heading">{heading}</h3>` edit text kept). Its
  scoped scss gains `.item { padding-left: $pad * 0.5; border-left: 2px solid rgb(40, 90, 160); }`: Panel styles
  PanelItem's root. Snapshots Panel feeds are updated.

## Tests

All run on this host and in CI's `check` and `svelte-floor` jobs (`pnpm devx test`, Playwright chromium installed
there since M3 3.9). No new infra.

- **Core**, `packages/core/test/blocks/svelte.spec.ts`, new `describe` over `svelte/roots/` (a row per fixture, a row
  for every fixture): dev and production builds compile with no warning (server, client); dev code snapshot; forwarded
  rows: each element root carries `{...__ucfScopeAttrs(<props>)}` once (`props` / `rest` / `__ucfRest` by row) and
  nothing else does; warning rows: `__ucfWarnFragment(` with the file name and the row's problem, no `__ucfScopeAttrs`,
  in production no helper import and no `$props()` edit. Render: server render (helper module written from
  `scopeHelperCode`, as 5.2 points class map imports at files) with the scope prop a stamped parent passes puts it once
  on the rendered root of each forwarded branch and on no inner element; warning rows put it nowhere.
  5.2's shape tests take the new edits: `undoBuild` also strips the spread, the `, ...__ucfRest`, the added
  `let __ucfRest = $props();`, the warning line and the helper import ("only inserts" still holds); the `added` script
  count includes them; `svelte/NoStyle.ucf` builds as written in production and gains only the warning in dev;
  `.svelte.snap` snapshots updated, the `.html` snapshots must not change.
- **Browser**, `packages/e2e/browser/svelte-scope-forward.spec.ts`, dev (`startDev`) and preview (`buildAndPreview`)
  of `apps/all-targets`:
  - main page: `#vue .item`, `#react .item`, `#svelte .item` each carry Panel's `data-v-*` (`scopeAttribute`) and
    PanelItem's own; `padding-left` and `border-left-*` are Panel's rule values; `expectSameComputedStyles` (M4's parity
    helper) across the three over those and PanelItem's own `color` / `margin-top`; no console warning or error.
  - `?page=roots`: every forwarded case's single root carries the parent's attribute once and its `.shape` color, its
    `.inner` does not; `EachRoot`, `MultiRoot`, `LegacyRoot` carry it on no element; dev logs exactly three warnings,
    one per name with its problem text; preview none.
- **SSR**, `packages/e2e/browser/svelte-ssr.spec.ts`: `<p ${item}="" class="item"` becomes
  `<p ${item}="" ${panel}="" class="item"`: Panel forwards to PanelItem in the server HTML, kept through hydration.
- **Fuzz**, `packages/e2e/build/svelte-scope.fuzz.spec.ts` + `build/lib/svelteScopeFuzz.ts`: one new rule `forwards`.
  - Each run dir gets a real `Parent.ucf` (`<svelte>` rendering `<Case {Child} />`, a `<style scoped>`); the batch
    entry renders both twins through it, so a real stamp `data-v-<parent>` reaches the case as a prop. The breakers
    apply only to `Fuzz…` ids.
  - Oracle: runes = `compile(plain, {generate: false}).metadata.runes` (the real compiler); root kind from the block's
    own parse (`single` = every branch at most one root, all element roots, no `{#each}` root; `many`, `each`, `other`,
    `none`), written apart from core's; the `.ucf` body's top-level elements by htmlparser2 with a depth count (void
    tags do not nest).
  - Rule `forwards`: runes `single` → each top-level element carries the parent's attribute exactly once; every case →
    no deeper element carries it; legacy, `many`, `each` → no element carries it.
  - `stamps` allows the parent's attribute beside the own one (`forwards` judges it); `same-html` strips it too.
  - Coverage facts gain `root:single`, `root:many`, `root:each`, required on a default run.
  - Two new negative controls for `forwards` (pre): the first ` {...__ucfScopeAttrs(…)}` removed; the spread copied onto
    the last stamped element (an inner one).
  - Seed 2026, 300 runs, unchanged.

## Docs

- `docs/milestones/m5-svelte-target.md`: 5.8 text to what shipped (fixture names, `Roots.ucf` page, the warning
  texts), then `- Status: done`; Risks gain the runes detection line; "Hands to later milestones" (M6) says `build()`
  also imports the scope helper module.
- `docs/spec.md` 3.6: the forwarding bullet gets the rules (whole component, which roots, legacy and dev-only warning
  with its own fix, spread after the stamp).
- `docs/architecture.md:99`: "The React and Svelte scope transforms call a forwarding helper…".
- `docs/plan.md` "5. Svelte target" (`:151`): a bullet for root forwarding through the props rest.
- No `publicdocs/` page describes Svelte forwarding yet (03-styles' table is React only): the docs writer adds it.

## Fuzzing

Covered by the step: the `forwards` rule above, proven by its two negative controls; also run on seeds 1, 7, 99 at
2000 runs on this host, results quoted here once shipped.

## Out of scope

- Legacy-mode forwarding through `$$props` / `$$restProps` (milestone Out of scope).
- Reading plugin-svelte's `compilerOptions.runes`.
- Editor types for the forwarded rest (5.9, 5.10).
- The milestone exit test (`svelte-exit.spec.ts`).

## Done when

- A Svelte child of a scoped `.ucf` parent gets the parent's `data-v-*` on its root, on every branch root of `{#if}`,
  `{#key}`, `{#await}`, `<svelte:boundary>`, and on a component root (passed on), in dev, in SSR HTML and after a build.
- Panel's scoped `.item` rule gives PanelItem's root the same computed style in Vue, React and Svelte.
- Multi-root, `{#each}` root and legacy components get no forwarding and one dev warning each; production has neither.
- The fuzz holds `forwards` over 300 files at seed 2026, and its two controls fail it.
- `pnpm devx check` passes; CI green on every job.
- Milestone doc has `- Status: done` on 5.8; this spec is in `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
