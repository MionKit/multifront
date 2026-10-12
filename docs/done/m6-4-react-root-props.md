---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.4
---

# Milestone 6.4: React root props: `className`, `style`, `ref`

## Problem

Spec 8 asks for every React component root to accept and merge `className` and `style`, and to forward `ref` (React 19,
where `ref` is a prop), with the author winning when the component handles a prop itself. Today the scope transform
(`packages/core/src/react/scope.ts:305-320`) only adds `{...__ucfScopeAttrs(props)}` to each JSX element root. A parent's
`<Button className="extra" style={…} ref={r} />` loses all three unless the author wired each one up.

Checked (React 19.3, `renderToString`): a function component and a `memo` component get `ref` in `props`; a `forwardRef`
render function does not (it gets it as the second parameter).

## Decisions

- Orchestrator (approved): no `mf-lint` rule; `mf-lint` does not exist until M7, and a syntactic rule documented in
  spec 3.5 is the smaller choice. The reason is recorded in spec 3.5.
- Orchestrator: no fuzz extension. Rule 2 of the scope fuzz learns the new legal inserts; rule 4 is unchanged.
- Orchestrator (approved): Button gets an own inline style in all three blocks; `react/root-props/Own.ucf` is rendered
  in the app (own-ref merge at runtime); `library.spec.ts` gets the "same in the library" check.
- Orchestrator (approved): hydration is checked on the dev server (React checks attribute mismatches only in dev); the
  client-render checks run on the real production build.

## Plan

### 1. `packages/core/src/react/reactApis.ts`

- `ROOT_PROPS = ['className', 'style', 'ref'] as const` (React prop names live in this file).

### 2. `packages/core/src/react/scopeHelper.ts`

- New names `MERGE_CLASS = '__ucfClass'`, `MERGE_STYLE = '__ucfStyle'`, `MERGE_REF = '__ucfRef'`, in the same module
  `virtual:multifront/scope-attrs` (id and output name `_virtual/multifront/scope-attrs.js` unchanged), in both the dev
  and the production `scopeHelperCode()`:
  - `__ucfClass(own, extra)`: `extra ? (own ? own + ' ' + extra : extra) : own`.
  - `__ucfStyle(own, extra)`: `extra ? (own ? {...own, ...extra} : extra) : own` (props win).
  - `__ucfRef(own, extra)`: one of them missing (or both the same) → the other; else a callback ref, cached per
    (own, extra) pair in nested `WeakMap`s, that sets both and returns a cleanup clearing both (React 19 ref cleanups;
    a callback ref that returns no cleanup is called with `null`).
  - No incoming prop → the author's own value comes back unchanged.

### 3. `packages/core/src/react/rootProps.ts` (new, internal to core)

- `handledRootProps(...)`: which of the three the component handles itself, plus `spreads`. The **detection rule**:
  1. The destructured first parameter has a top-level key `P` (`{className}`, `{className: extra}`, `{style = {}}`).
  2. The plain props name is read as `props.P`, `props?.P` or `props['P']` anywhere in the component.
  3. A destructuring of the plain props name anywhere in the component (`const {ref, ...rest} = props`) has key `P`.
  4. `P` is `ref` and the component is wrapped in `forwardRef`.
  - `spreads`: the plain props name, and the rest binding of the parameter pattern or of a rule 3 destructuring.
- `addRootProps(...)`, per root:
  - The root has an author spread `{...x}` with `x` in `spreads` → nothing for any of the three.
  - For each `P` not handled, in the order `className`, `style`, `ref`:
    - Own `P={expr}` → `P={__ucfX(expr, <props>.P)}`; own `className="lit"` → `className={__ucfClass("lit", <props>.className)}`.
      Inserts only. Several own `P` → the last one.
    - Own `P` with no value, an empty `{}`, or a string `style` / `ref` → left alone.
    - No own `P` → ` P={<props>.P}` added at `afterName`, right after the forwarding spread, before every author
      attribute (an author spread carrying `P` still wins at runtime).
- Same roots as the scope forward; nothing when forwarding is off.

### 4. `packages/core/src/react/scope.ts`

- Root loop: after each spread, `addRootProps(...)`. Helpers returned in order
  `__ucfScopeAttrs, __ucfWarnFragment, __ucfClass, __ucfStyle, __ucfRef`. `react.ts` unchanged.

### 5. No `mf-lint` rule

- A props object passed on whole (`useThing(props)`, `<Inner {...props} />` not on the root) is not detected: the root
  still gets the props. Documented; destructuring the prop opts out.

### 6. Fixtures

- `packages/e2e/fixtures/components/react/root-props/`, `<react>` only: `Own.ucf`, `Destructures.ucf`,
  `ReadsProps.ucf`, `BodyDestructure.ucf`, `SpreadsProps.ucf`, `OtherSpread.ucf`, `Valueless.ucf` (one rule each).
- `packages/e2e/fixtures/library/src/Button.ucf`: own inline `font-weight: 600` in all three blocks.
- New app `packages/e2e/fixtures/apps/react-root-props/`: `vite.config.ts`, `index.html` (`<!--ssr-->` in `#app`),
  `src/App.tsx` (Button, Badge, Own with `className="extra"`, `style={{color: 'red'}}`, refs; ref tag names in
  `<output data-ref>`), `src/main.tsx` (hydrate when `#app` has an element), `src/entry-server.tsx`.

### 7. Test helpers

- `packages/core/test/blocks/injected.ts` `withoutInjected` also removes the added root-prop attributes and the merge wraps.

## Tests

- **`packages/core/test/react/scope.spec.ts`** (core project: this host, CI `check` and `react-floor`): a `ROOT_PROPS`
  table per fixture and root (`added` / `merged` / `author` / `none` for each prop) with a completeness test; dev and
  production builds parse, snapshot, only insert, and match the table. `forwardRef` rows get no `ref`. Helper imports =
  the `__ucf*` functions called. The helper module test checks the merge helpers' behaviour. 3.10's mapping test reads
  past the added attributes. Snapshots updated and reviewed.
- **`packages/core/test/blocks/react.spec.ts`**: snapshots updated.
- **`packages/e2e/build/scope-fuzz.spec.ts`**: rule 2's insert list gains the new fixed texts. Negative controls unchanged.
- **`packages/e2e/build/library.spec.ts`**: `react/Button.js` imports `__ucfClass` and `__ucfStyle` from
  `./_virtual/multifront/scope-attrs.js`; `react/Badge.js` imports no `__ucfClass`; only that helper file defines `__ucf*`.
- **`packages/e2e/browser/react-root-props.spec.ts`** (this host via `MULTIFRONT_CHROMIUM_PATH`, CI `check` and
  `react-floor`, no new infra): production build + preview: Button class list, color, font-weight, ref tag `BUTTON`;
  Badge `badge extra` once; Own `own extra`, padding, color, own and parent ref both `SECTION`; no console problem.
  Dev server: SSR HTML from the module runner injected through `page.route`, hydrated: same checks, no `#app` node
  removed, no console problem.

## Docs

- `docs/spec.md` 3.5 item 5 "Root props" and the helper line; spec 8 points to it.
- `docs/architecture.md` "Build": the helper module also holds the merge helpers.
- `docs/plan.md`: none.
- Milestone doc: step 6.4 matched to what ships, `- Status: done`; the root-props risk records the decision.
- Public docs: none (the milestone's docs writer).

## Fuzzing

- Rule 2 of the 3.13 scope fuzz learns the new inserts. Rule 4 is unchanged.

## Out of scope

- Types of the root props (6.5), `.d.ts` (6.6), consumer apps (6.10, 6.12).
- A `forwardRef` wrapper for React 18, opt-out per component (spec 12), class components, roots that are not JSX.
- Detecting props passed on whole.

## Done when

- Every test above passes on this host and in CI `check` and `react-floor`, with the new browser test seen executing
  in the CI log.
- `pnpm devx check` passes; snapshot changes reviewed.
- Spec, architecture and milestone doc updated; this todo moved to `docs/done/` matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.

## As shipped

- 3.5's token row for `ScopedPanel` in `react.spec.ts` marks `"panel"`: the root's own `className="panel"` is now the
  first argument of its merge, so the old token text no longer appears whole.
- `withoutInjected` strips an added attribute only for the three root props, so an author's `branch={props.branch}`
  right after the spread stays (`ComponentRoot`).
- `Valueless.ucf` holds a `// @ts-expect-error` on its valueless `className`, the type error it carries on purpose.
- The hydration test serves the dev page through `page.route` with the SSR HTML in `#app`, and a `MutationObserver`
  from `addInitScript` sees no element removed under `#app`.
