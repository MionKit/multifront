---
type: feature
spec: full-plan
status: done
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
  call is no store, nor is svelte/store's `derived` beside `$derived`. With no rune and no `export let`, `$:`,
  `$$props`, `$$restProps`, Svelte's `maybe_runes` (`index.js:499-505`) leaves the mode to the compiler option, and
  runes mode rejects `$$props` (`legacy_props_invalid`).
- `parse(…, {modern: true})`: `root.options?.runes` is `true` / `false` / `undefined`; a script's `content.end` is right
  before `</script>`; a `<svelte:boundary>`'s `{#snippet failed}` is a `SnippetBlock` in its `fragment.nodes`.
- `compile(code, {generate: false}).metadata.runes` says whether Svelte reads a file in runes mode, without generating
  code (the fuzz oracle).

## Decisions

- **The mode is read from the block**, by Svelte's own rule (`SvelteMode` in `types.ts`): `runes` on
  `<svelte:options runes>`, else a rune reference (a `$state` whose `state` is a top-level non-rune declaration is a
  store); `legacy` on `<svelte:options runes={false}>`, `export let`, `$:`, `$$props` or `$$restProps`; else
  `undecided`. A legacy block warns and does not forward (orchestrator: milestone Risks "Forwarding is runes-mode only",
  Out of scope "legacy-mode root forwarding"). An undecided block (markup only, like `svelte/NoStyle.ucf`) gets no edit
  at all (review, blocking): `$props()` would switch it to runes mode, and `$$props` breaks it where plugin-svelte's
  `compilerOptions.runes: true` compiles it as runes; core cannot see that option. So a project forcing runes there
  still needs one rune in a block (any `$props()`) for it to forward (milestone Risks).
- **Whole component**, as the step says: any branch with more than one root, or an `{#each}` root, means no forwarding
  and one warning at init. React's warning fires only on a rendered fragment root; a Svelte branch cannot warn from
  markup without changing the HTML.
- **Spread right after the stamp**, after the tag name, as React writes `data-v-x="" {...__ucfScopeAttrs(props)}`.
- **Dev-only warning**, as React: in production a non-forwarding component gets no edit at all, and the helper module
  exports only `__ucfScopeAttrs` (`scopeHelperCode(false)`).
- **Svelte's double escape is worked around here** (found by the fuzz, own commit): beside a spread, Svelte 5.57.0's
  server render escapes a plain-text attribute value twice (`<div {...p} data-html="<div>">` renders
  `data-html="&amp;lt;div>"`; the client is right). Every root we forward gains a spread, so a forwarded
  `RegularElement` / `SvelteElement` root's plain-text attribute holding `&`, `<` or `"` becomes an expression of its
  decoded text (`data-html={"<div>"}`), which Svelte escapes once. Mixed values (`"a {b}"`) and component props are not
  affected.
- **The fuzz's `same-html` ignores Svelte's load replay** (found by seeds 1 and 7 at 2000 runs): Svelte's server render
  adds ` onload="this.__e=event" onerror="this.__e=event"` to an `<img>` (any load-event element) with a spread, so a
  forwarded `<img>` root differs from its plain twin there. Svelte's own behavior for any spread, so both HTMLs drop
  those two attributes before comparing (milestone Risks names the CSP side of it).
- **Instance lines go after the last statement** of the instance script (not at `content.end`), so the generated code
  keeps its closing-tag indent and 5.2's "only inserts" check stays a line strip.
- **A props name hidden around a root is aliased** (review): `{:then props}`, `{:catch rest}` or a boundary snippet's
  parameter named like the props source would make the spread read the wrong value, so the build adds
  `const __ucfProps = $derived(props);` and spreads from that (no `state_referenced_locally`).
- **`on…` attributes stay text** in `escapeOnce` (review): Svelte rejects a text event attribute
  (`attribute_invalid_event_handler`); as an expression it would compile into a string handler.
- **Warning text** (orchestrator, Q1 = b): `__ucfWarnFragment` takes optional `problem` and `fix`; React's call and
  text stay as they are; Svelte passes "renders more than one root", "renders an {#each} block as its root", or "is a
  legacy-mode Svelte component" with "Use $props() to make it a runes-mode component."

## Plan

### Root analysis and forwarding: `packages/core/src/svelte/forward.ts` (new)

`isNode`, `walk` and `patternNames` move from `packages/core/src/blocks/svelte.ts` to `packages/core/src/svelte/ast.ts`;
the node type becomes `SvelteNode` in `types.ts`, shared by both. 5.2's `STAMPED` set moves to `forward.ts` as the
exported `ELEMENTS`, which `stampScope` reads too.

- `branchRoots(nodes, found, bound)`: walks one branch into the `Roots` record `{elements, many, each}`. Not counted:
  whitespace-only `Text`, `Comment`, `SnippetBlock`, `ConstTag`, `DebugTag`, `SvelteHead`, `SvelteWindow`,
  `SvelteBody`, `SvelteDocument`; more than one counted node sets `many`. A counted `IfBlock` → its `consequent` and
  `alternate` are branches (an `{:else if}` is the one `IfBlock` of `alternate`: recursion covers it); `KeyBlock` → its
  `fragment`; `AwaitBlock` → `pending`, `then`, `catch` (each may be `null`); `SvelteBoundary` → its non-snippet
  children are one branch, the body of each `{#snippet}` child (`failed`, `pending`) another; `EachBlock` sets `each`;
  an element root (`RegularElement`, `SvelteElement`, `Component`, `SvelteComponent`, `SvelteSelf`) goes into
  `elements` with `bound`, the names an enclosing `{:then}`, `{:catch}` or boundary snippet binds. Any other root (text,
  `{expr}`, `{@render}`, `{@html}`, `<slot>`) gets nothing and no warning, as React's `null` / text / `children` roots.
- `forwardScope(text, root, block, ctx, used, mode)`, called from `build()` after the renames and `stampScope`: no
  element root and no `{#each}` root, or an undecided block → no edit. Runes, not `many`, not `each` → forward.
  Otherwise, dev → warn; production → nothing. Returns `{helpers, lines}`: the helper names to import and the lines for
  the instance script.
- **Props source** (`propsName`: the first declarator of a top-level `VariableDeclaration` whose init is a plain
  `$props()` call, `let` or `const`): `let props = $props()` → forward from `props`; `let { a, ...rest } = $props()` →
  reuse `rest`; `let { a }: T = $props()` → insert `, ...__ucfRest` after the last property (with a trailing comma:
  ` ...__ucfRest` after the comma, as a comma after a rest is a syntax error; spaces and `//` / `/* */` comments
  between are skipped by one regular expression); `let {} = $props()` → `{...__ucfRest}`. No `$props()` →
  `let __ucfRest = $props();` added to the instance script (an added `<script>` when the block has none).
  `__ucfRest` = `freshName(used, '__ucfRest')`. A root whose `bound` holds the name → the alias (Decisions).
- **Forward**: ` {...__ucfScopeAttrs(<props>)}` `appendLeft` at the end of each element root's name (the stamp's
  offset, so after it), mapped like the stamp; then `escapeOnce` turns the root's plain-text attribute values holding
  `&`, `<` or `"` into expressions, `on…` ones excepted (Decisions).
- **Warn** (dev): runes → the props source as above, then `;(() => __ucfWarnFragment(<props>, "<Name>", …))();` as
  the instance script's last line; legacy → `;__ucfWarnFragment($$props, "<Name>", …);`. `<Name>` =
  `basename(ctx.filename, '.ucf')`, as React.
- **Mode detection**: `styleUses` (`blocks/svelte.ts`) already visits every identifier with the property, import,
  export and type filters; it also sets `runes` on a `$<rune>` reference that is no store, `legacy` on `$$props` /
  `$$restProps`, and returns the `mode` with `root.options.runes` first. `runeDeclared` keeps `$name` a rune when the
  top-level `name` is declared by a rune call or is svelte/store's `derived`; `legacyScript` finds `$:` and
  `export let` (also `export {x}` of a top-level `let`).

### `packages/core/src/blocks/svelte.ts` `build()` (`:173-206`)

- Imports gain `import {…} from "virtual:multifront/scope-attrs";` (`SCOPE_HELPER_ID`) when `forwardScope` returns
  helpers, placed where the class map imports go (module script, else instance, else added `<script>`).
- Instance lines (`let __ucfRest = $props();`, the warning call) go after the instance script's last statement;
  with no instance script into an added `<script>`, which also takes the imports when there is no module script either
  (one added script, not two).

### `packages/core/src/react/scopeHelper.ts:17-27`

`__ucfWarnFragment(props, name, problem = 'renders a fragment root', fix = 'Render one root element instead.')`.

### Fixtures

- `packages/e2e/fixtures/components/svelte/roots/` (each a `<svelte>` block, `.shape` on each root,
  `<span class="inner">` inside, a row in the core test):
  - forwarded: `IfElseRoot.ucf` (`{#if}` / `{:else if}` / `{:else}` roots, own `<style scoped>`, a `{@const}`, a comment
    before the trailing comma of its `$props()` pattern), `PassOnRoot.ucf` (root `<SvelteElementRoot tag="article" />`),
    `SvelteElementRoot.ucf` (`<svelte:element this={tag}>`, an escaped `title`), `NestedRoot.ucf` (`{#key}` →
    `<svelte:boundary>` with a `{#snippet failed}` root → `{#if}` with a throwing root / `{#await}` pending / then /
    catch roots, `let props = $props()`), `RestRoot.ucf` (`const shown = …, { label, ...rest } = $props()`),
    `NoPropsRoot.ucf` (`$state`, no `$props()`), `EscapedRoot.ucf` (plain-text attribute values Svelte escapes, and a
    mixed one), `EmptyPropsRoot.ucf` (`let {} = $props()`, the name `__ucfRest` taken), `OptionsRoot.ucf` and
    `EmptyScriptRoot.ucf` (`<svelte:options runes />`, no script / an empty one), `PropsOnlyRoot.ucf` (`let props =
    $props()` its only rune), `ShadowRoot.ucf` (`{#await … then props}` root), `StoreDerivedRoot.ucf` (`$derived`
    beside svelte/store's `derived`), `StringHandlerRoot.ucf` (`onclick="…"` left for Svelte's error);
  - warning: `EachRoot.ucf`, `MultiRoot.ucf` (an element root beside a text root, a line comment before the trailing
    comma), `LegacyRoot.ucf` (`export let`), `LegacyStoreRoot.ucf` (`$state` of a store, rune names as property names);
  - unchanged: `TextRoot.ucf` (text root only).
- `packages/e2e/fixtures/apps/all-targets/Roots.ucf` (a Svelte parent, as M3's `react-scope/Parent.ucf`): scoped
  `.shape { color: rgb(200, 40, 80) }`, each fixture but `StringHandlerRoot` (each `IfElseRoot` and `NestedRoot`
  branch) in a `<div data-case="Name:branch">`.
  `src/main.tsx`: `?page=roots` mounts only `Roots` into `#svelte` (the default page stays free of warnings for 5.5's
  console checks), else the page as today.
- `Panel.ucf`: the `<vue>` and `<react>` blocks import `./PanelItem.ucf` and render `<PanelItem label="first item" />`
  after the `<h3>`, as the `<svelte>` block does (5.5's `<h3 className="heading">{heading}</h3>` edit text kept). Its
  scoped scss gains `.item { padding-left: $pad * 0.5; border-left: 2px solid rgb(40, 90, 160); }`: Panel styles
  PanelItem's root. Snapshots Panel feeds are updated.

## Tests

All run on this host and in CI's `check` and `svelte-floor` jobs (`pnpm devx test`, Playwright chromium installed
there since M3 3.9). No new infra.

- **Core**, `packages/core/test/svelte/forward.spec.ts` (mirrors `src/svelte/forward.ts`; the build and server render
  helpers it shares with `test/blocks/svelte.spec.ts` live in `test/svelte/render.ts`), a row per `svelte/roots/`
  fixture and a test that every fixture has one: dev and production builds compile with no warning (server, client),
  or with the row's own Svelte error; dev code snapshot; forwarded rows: each element root carries
  `{...__ucfScopeAttrs(<props>)}` once (`props` / `rest` / `__ucfRest` / `__ucfRest1` / `__ucfProps` by row) and
  nothing else does; warning rows: `__ucfWarnFragment(` with the file name, the row's problem and fix, no
  `__ucfScopeAttrs`, in production no helper import and no `$props()` edit; the unchanged row builds as written. Render:
  server render (helper module written from `scopeHelperCode`, another fixture's `.ucf` import built the same way) with
  the scope prop a stamped parent passes puts it once on each top-level element of a forwarded row (`startTags` counts
  repeats and depth) and on no inner element; warning rows put it nowhere; `EscapedRoot` and `SvelteElementRoot`
  hold each attribute escaped once.
  5.2's shape tests take the new edits: `undoBuild` also strips the spread, the `, ...__ucfRest`, the added lines and
  the helper import ("only inserts" still holds); every other line of an added script is a forwarding one; the mapping
  test reads the text after the stamp and its spread; `svelte/NoStyle.ucf` (undecided) builds as written in dev and in
  production; `.svelte.snap` snapshots updated, the `.html` snapshots did not change. Panel's own snapshots (split,
  styles, React scope, editor virtual code) follow its new lines.
- **Browser**, `packages/e2e/browser/svelte-scope-forward.spec.ts`, dev (`startDev`) and preview (`buildAndPreview`)
  of `apps/all-targets`:
  - main page: `#vue .item`, `#react .item`, `#svelte .item` each carry Panel's `data-v-*` (`scopeAttribute`) and
    PanelItem's own; `padding-left` and `border-left-*` are Panel's rule values; `expectSameComputedStyles` (M4's parity
    helper) across the three over those and PanelItem's own `color` / `margin-top`; no console warning or error.
  - `?page=roots`: every forwarded case's single root (`NestedRoot`'s then, catch and failed branches included) shows
    its text, carries the parent's attribute once and its `.shape` color, its `.inner` does not; escaped attributes
    read back as written; `TextRoot`, `EachRoot`, `MultiRoot`, `LegacyRoot`, `LegacyStoreRoot` carry it on no element;
    dev logs exactly four warnings, each the full text with its problem and fix; preview none.
- **React**, `packages/e2e/browser/react-scope.spec.ts`: the fragment warning is checked as its full text, so the
  helper's default `fix` is pinned.
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
  - `stamps` allows the parent's attribute beside the own one (`forwards` judges it); `same-html` strips it too, and
    Svelte's ` onload` / ` onerror="this.__e=event"` load replay from both HTMLs (Decisions).
  - Coverage facts gain `root:single`, `root:many`, `root:each` and `forwards:root`, `forwards:none` (the expectation
    each usable case got), required on a default run.
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
2000 runs on this host (Results).

## Results

Run on this host (2026-10-12), each a `pnpm devx test packages/e2e/build/svelte-scope.fuzz.spec.ts` line, as Vitest
printed it:

- Default (seed 2026, 300 runs), `--reporter=verbose`: `✓ … holds every rule over 300 generated files (seed 2026)
  9233ms`, the eight controls passing, among them `a dropped forward fails rule forwards 2229ms` and
  `a forward on an inner element fails rule forwards 2314ms`; `Tests 9 passed (9)`, `Duration 45.49s`.
- On the first pass, the default run found Svelte's double escape beside a spread (`data-html="&amp;lt;div>"`, run 144;
  fixed in core, `EscapedRoot.ucf`), and seeds 1, 7 and 99 at 2000 runs each found the `<img>` load replay (runs 69,
  583, 1816; Decisions).
- After both: `MULTIFRONT_FUZZ_SEED=1 MULTIFRONT_FUZZ_RUNS=2000`, `-t "holds every rule"`: `Tests 1 passed | 8 skipped
  (9)`, `Duration 73.62s`; seed 7: `Duration 76.14s`; seed 99: `Duration 73.44s`, each `1 passed`.
- `svelte-scope-forward.spec.ts` fails all four tests with the spread line of `forwardScope` removed, and the core
  forwarding tests fail 21 of 58; without `escapeOnce`, `EscapedRoot`'s render and snapshot tests fail.

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
