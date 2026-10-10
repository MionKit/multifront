---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.11
---

# Milestone 3.11: Root forwarding and the helper module

## Problem

Stamping (3.10) puts `data-v-<id>=""` on every element of a `.ucf` block, so a parent's scoped rule
`.shape[data-v-parent]` matches its own elements and the child *component* elements it renders
(`<Child data-v-parent="">`). React hands that attribute to the child as a prop, and nothing passes it on to the
child's DOM root, so the parent's scoped style never reaches the child root. Vue does this through fallthrough attrs.
Spec 3.5 (item 3) and 3.5.1 ask for the React version: every returned root of the default-exported component gets
`{...__ucfScopeAttrs(props)}`, on every component, scoped style or not. The helper is a virtual module served by the
Vite plugin, so it is bundled once. Today `react.build` (`packages/core/src/blocks/react.ts:120-138`) only parses the
block when it has style imports, and has no forwarding.

## Plan

### 1. `packages/core/src/react/scopeHelper.ts` (new, exported from core's index)

- `SCOPE_HELPER_ID = 'virtual:multifront/scope-attrs'`, plus the two helper names `SCOPE_ATTRS = '__ucfScopeAttrs'`,
  `WARN_FRAGMENT = '__ucfWarnFragment'` (internal, read by `scope.ts`).
- `scopeHelperCode(dev: boolean): string`, plain JS (no TS, the id has no extension):

  ```js
  export function __ucfScopeAttrs(props) {
    const attrs = {};
    for (const key in props) if (key.startsWith('data-v-')) attrs[key] = props[key];
    return attrs;
  }
  // dev only:
  const warned = new Set();
  export function __ucfWarnFragment(props, name) {
    if (warned.has(name)) return;
    const keys = Object.keys(__ucfScopeAttrs(props));
    if (keys.length === 0) return;
    warned.add(name);
    console.warn(`[multifront] <${name}> renders a fragment root, so no element receives ${keys.join(', ')} ...`);
  }
  ```

  `name` = the `.ucf` file's base name without its extension (`FragmentRoot`), as Vue names a component in its dev
  warnings (`at <FragmentRoot>`). It is also the "once per component" key. StrictMode double renders still warn once.
- `packages/core/src/index.ts`: export `SCOPE_HELPER_ID`, `scopeHelperCode`.

### 2. `packages/core/src/react/scope.ts`

- `reactNames(program, api): Set<string>`: today's `fragmentNames` generalized. Local names that mean React's `api`:
  `{api}` / `{api as X}` / quoted, and `R.api` for a default / namespace / `{default as R}` import of `'react'`;
  type-only imports skipped. Used for `FRAGMENT` and each of `WRAPPERS` (`memo`, `forwardRef`, from `reactApis.ts`).
- The 3.10 walk becomes `fragmentOpenings(program): Set<JSXOpeningElement>` (same shadowing rules). Stamping reads it;
  forwarding uses it to tell a fragment root.
- One entry point, called by `react.build` for every build:

  ```ts
  transformScope(text: MagicString, parsed: {program: Program; comments: Comment[]}, block: Block, ctx: BuildContext): string[]
  ```

  Stamps when `ctx.hasScoped` (3.10, unchanged), then forwards; returns the helper names used (`[]`,
  `['__ucfScopeAttrs']`, `['__ucfWarnFragment']` or both) for the header import.
- **Find the component.** Start at the default export: `export default <expr>`, `export default function`, or
  `export {X as default}` (no `source`). Resolve in a loop, guarded by a visited set:
  - Identifier → its module-level `function X` or `const X = …` (also under `export`); anything else (import, `let`,
    class) → no component.
  - Parentheses, `as`, `satisfies`, `!` → their expression.
  - A call whose callee is a React wrapper (`reactNames` of `memo` / `forwardRef`, so `memo`, an `m` alias,
    `React.memo`, `React.forwardRef`) → its first argument, nested in any order. Remember when a `forwardRef` was passed.
  - Function declaration / expression or arrow → the component. Class → none ("stamped but not forwarded").
- **Props name.** First parameter: Identifier → its name; `props = {}` → `props`. No parameter → insert `__props`
  (inside `forwardRef`: `__props, __ref`, so React's "exactly two parameters" check stays quiet) into the empty `()`,
  found as the first `(` after `typeParameters ?? id ?? node.start` that is in no comment (oxc gives no span for an
  empty list). Only inserted when some root needs it. A pattern or rest parameter → no forwarding at all in this step
  (3.12 rewrites destructured props).
- **Collect roots.** Every `return` argument in the function body, not entering nested functions, plus the expression
  body. Unwrap: parentheses, `as` / `satisfies` / `!`, both branches of `?:`, the right side of `&&` / `||` / `??`, and
  one hop of an Identifier to the single `const x = …` of that name in the same function (not nested functions; two
  such declarators → no hop); after that hop identifiers stop. Dedupe by node.
- **Edit each root** (inserts only, `.ucf` offsets):
  - `JSXElement` not in `fragmentOpenings` → `appendLeft(offset + (typeArguments ?? name).end, ' {...__ucfScopeAttrs(<props>)}')`,
    after the stamp (stamping runs first, so `<div data-v-own="" {...__ucfScopeAttrs(props)} …>`). Component roots too.
  - `JSXFragment` or a React-Fragment element → dev (`!ctx.production`):
    `prependRight(start, '(__ucfWarnFragment(<props>, "<Name>"), ')` + `appendLeft(end, ')')`.
    Production: nothing.
  - Anything else (`null`, strings, calls, `children`, …) → nothing.

### 3. `packages/core/src/blocks/react.ts` `build`

- Always parse the block (`parseSync`, keeping `comments`); call `transformScope`.
- Header imports = style imports, class maps, then
  `import {__ucfScopeAttrs, __ucfWarnFragment} from "virtual:multifront/scope-attrs";` (only the names used, none →
  no line). Same prologue placement as today, so `"use client"` stays first.

### 4. `packages/vite/src/index.ts` (pre plugin, no new plugin: `multifront()` keeps returning `[pre, attributes]`)

- `resolveId` filter also matches `^virtual:multifront/scope-attrs$`; that id → `'\0' + SCOPE_HELPER_ID`.
- `load` filter also matches `^\0virtual:multifront/scope-attrs$`; returns `scopeHelperCode(!config.isProduction)`
  (same flag as `ctx.production`, so a dev module never calls a missing export).
- The scan plugin is unchanged: it serves the raw block, which never names the helper.

### 5. Fixtures

- `packages/e2e/fixtures/components/react/shapes/`, `<react>` only (no `<vue>` / `<svelte>`: M6 copies them). Each root
  has `className="shape"` and holds a `<span className="inner">`. Props `{branch?: string}`:
  - `MultiReturn.ucf`: `if (props.branch === 'early') return (<section …>)!`, then `return <div …>`; a nested
    `items.map((item) => { return <li>… })` that must not forward. Its own `<style scoped>` (`.inner` font-style), so a
    root carries its own id and the parent's.
  - `Ternary.ucf`: `return (cond ? <div> : <p>) as ReactElement`.
  - `NestedTernary.ucf`: `a ? <div> : b ? <p> : <section>`, with `satisfies ReactNode`.
  - `AndRoot.ucf`: `return props.fallback || <p>`, `return props.fallback ?? <section>`, `return props.branch === 'and' && <div>`.
  - `Memo.ucf`: `export default memo(function Memo(props: Props) {…})`.
  - `ForwardRef.ucf`: `forwardRef<HTMLDivElement, Props>(function ForwardRef(props, ref) { return <div ref={ref} …> })`.
  - `MemoForwardRef.ucf`: `import * as React`, `React.memo(React.forwardRef(() => <div …>))` → `(__props, __ref)`.
  - `ExportIdentifier.ucf`: `function Inner(props)`, `const ExportIdentifier = m(Inner)` (with `import {memo as m}`),
    `export default ExportIdentifier`.
  - `ArrowExpression.ucf`: `export default (props: Props) => (<div …>)`.
  - `NoParams.ucf`: `export default function NoParams() { return <div …> }` → `NoParams(__props)`.
  - `ConstRoot.ucf`: `const root = <article …>; return root`.
  - `ComponentRoot.ucf`: root `<ArrowExpression />` imported from `./ArrowExpression.ucf` (no attribute, 4.1): the
    chain continues down.
  - `FragmentRoot.ucf`: branch `short` returns `<>…</>`, `named` returns `<Fragment>…</Fragment>`.
  - `NullRoot.ucf`: branches `null`, `string`, `call` (`return renderLabel()`, a local function returning a `<span>`),
    `children` (`return props.children`): the documented non-JSX roots.
- `packages/e2e/fixtures/apps/react-scope/Parent.ucf`: `<main className="parent">` rendering, once per branch,
  `<div data-case="<Shape>:<branch>"><Shape branch="…" /></div>` for all 14 shapes; `ForwardRef` gets a `useRef` and
  an effect that sets `data-ref="forward-ref"` on `ref.current`; `NullRoot`'s `children` case passes a text child.
  `<style scoped>`: `.shape { color: rgb(200, 40, 80) }`.
- `react-scope/src/main.tsx`: renders `<Parent />` when the URL has `?page=shapes`, else `<Stamped />` as today, so
  each page has its own console (the stamped page must stay warning-free, the shapes page warns once in dev).

### 6. Test helper

- `packages/core/test/blocks/injected.ts` `withoutInjected(code, program)` also removes, by AST offsets of the output
  parse: the helper import, every ` {...__ucfScopeAttrs(x)}` spread, the `(__ucfWarnFragment(…), ` … `)` wrapper, and
  inserted `__props` / `__props, __ref` params. `scope.spec.ts` strips stamps after it (offsets come from the stamped
  code). 3.5's "adds nothing else" test in `react.spec.ts` keeps working through it.

## Tests

- **`packages/core/test/react/scope.spec.ts`** (core project: this host, CI `check` and `react-floor`).
  - New `SHAPES` table, hand-read from the fixtures: `{fixture, props, roots, fragments}` (`roots` = names of the
    opening elements that get the spread, in source order; `fragments` = fragment roots). A first test fails when
    `listComponents('react/shapes')` and the table differ.
  - Per shape, dev build (`production: false`): a code snapshot (`__snapshots__/react/scope/react/shapes/<X>.ucf.tsx.snap`);
    output parses; inserts only (`withoutInjected` + stamps removed = block content); the elements carrying a
    `__ucfScopeAttrs` spread are exactly `roots`, each spread's argument is `props`; `__ucfWarnFragment(<props>,
    "FragmentRoot")` calls = `fragments`; the helper import names exactly the helpers used (none for `NullRoot`);
    `MemoForwardRef` params are `(__props, __ref)`, `NoParams` `(__props)`.
  - Per shape, production build: same spreads, no `__ucfWarnFragment` anywhere, import names `__ucfScopeAttrs` only.
  - `MultiReturn.ucf` joins the 3.10 `SCOPED` list (its sweep finds it); every existing case's snapshot now shows
    forwarding, `AllBlocks.ucf` included (forwarding without a scoped style).
- **`packages/core/test/blocks/react.spec.ts`**: 3.5 snapshots updated; "adds nothing else" still passes through the
  extended `withoutInjected`.
- **`packages/e2e/build/react-target.spec.ts`** (area: build, real `vite build` of `react-basic`): the chunk holds
  `\0virtual:multifront/scope-attrs`, `function __ucfScopeAttrs(` appears once (several forwarding components, one
  helper), and no `__ucfWarnFragment`.
- **`packages/e2e/browser/react-scope.spec.ts`** (area: browser; this host with `MULTIFRONT_CHROMIUM_PATH` from
  `.env`, CI `check` and `react-floor`, Chromium already installed since 3.9: no new infra), dev and preview, page
  `?page=shapes`, expected ids from core's `scopeId(relative path, source, production)`:
  - every case of a hand-written table: forwarding shapes → the wrapper has one element child, it carries the
    parent's `data-v-<Parent id>`, its computed `color` is `rgb(200, 40, 80)`, its `.inner` does not carry the parent's
    id; `MultiReturn` roots also carry MultiReturn's own id; `FragmentRoot` / `NullRoot` → no element under the wrapper
    carries the parent's id.
  - `ForwardRef:only`'s root has `data-ref="forward-ref"` (the ref still points at the DOM node).
  - console after `networkidle`: dev → exactly one warning, naming `<FragmentRoot>`; preview → none; no error or
    pageerror in either.
  - The 3.10 stamped test is unchanged (root URL).

## Docs

- `docs/spec.md` 3.5, item 3: what counts as a root (returns, expression body, the unwraps, one `const` hop; `null`,
  strings, calls, `children` get nothing), `props` (first parameter, else `__props`, `(__props, __ref)` in
  `forwardRef`), and the dev-only fragment warning naming the component by its file's base name.
- `docs/architecture.md`, "Build": one line, the Vite plugin serves `virtual:multifront/scope-attrs`, bundled once.
  Graphics unchanged.
- `docs/plan.md`: none (no decision changes).
- Milestone doc: step 3.11 matched to what ships (`?page=shapes`, the warning name = the file's base name,
  `export {X as default}` followed, the helper served by the pre plugin, the spread after the stamp),
  `- Status: done`.
- Public docs: none (the milestone's docs writer).

## Fuzzing

None here: 3.13 owns the scope fuzz and records which roots are JSX elements.

## Out of scope

- Destructured / rest first parameters (no forwarding until 3.12) and `__props` name clashes (3.12).
- Fuzz (3.13), HMR (3.15), class components, HOCs other than `memo` / `forwardRef`, non-JSX roots, a build warning
  for them (open question 3), opt-out (open question 5).

## Done when

- Every test above passes on this host and in CI `check` and `react-floor`, with the new browser tests seen executing
  in the CI log.
- `pnpm devx check` passes; snapshot changes reviewed.
- Spec, architecture and milestone doc updated; this todo moved to `docs/done/` matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Decisions

- Orchestrator (AMEND): the warning names the component by the `.ucf` base name without its extension
  (`FragmentRoot`), as Vue's `formatComponentName` does; it is also the once-per-component key.
- Orchestrator (approved): the helper is served by the existing pre plugin, not a third plugin, so the `Plugin[]`
  hand-off stays as listed.
- Orchestrator (approved): `export {X as default}` is followed like `export default X`.
- Orchestrator (approved): the spread goes after the stamp, so 3.10's "stamp is the first attribute" mapping test holds.
- Orchestrator (approved): `react-scope` switches pages by `?page=shapes` rather than a second HTML entry.
