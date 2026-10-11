---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 3
step: 3.12
---

# Milestone 3.12: Destructured props

## Problem

Root forwarding (3.11) spreads `{...__ucfScopeAttrs(<props>)}` on each JSX root, where `<props>` is the component's
first parameter. When that parameter is a pattern (`function Badge({label}: Props)`), no name holds every prop, so
`transformScope` returns early (`packages/core/src/react/scope.ts:243-246`) and a parent's scoped style never reaches
the child root. Most real components destructure, and so do many fixtures (`Card.ucf`, `Badge.ucf`,
`editor/StyleModuleEdges.ucf`, ...). Spec 3.5 item 4 and 3.5.1 ask for the rewrite `(__props)` +
`const {...} = __props`.

## Plan

### 1. `packages/core/src/react/scope.ts`

- **Pick the props parameter.** `params` = `component.params` without a leading TS `this` parameter (oxc gives it as
  an `Identifier` named `this`; today it becomes `__ucfScopeAttrs(this)`, a related bug, fixed in its own commit).
  Only a `this` parameter → no forwarding.
  - `RestElement` first: no forwarding (unchanged, documented).
  - `Identifier`, or an `AssignmentPattern` whose left is one: that name, as today (the `bound.has(props)` check stays).
  - `ObjectPattern` / `ArrayPattern`, or an `AssignmentPattern` whose left is one: **destructured**, props = a fresh name.
  - None: a fresh name, as today's `__props`.
- **Fresh names.** `freshName(program, base)`: `base`, then `base1`, `base2`, ...: the first that no `Identifier` or
  `JSXIdentifier` anywhere in the block uses (it can never shadow or be shadowed). Used for `__props` (destructured
  and no-param) and for `__ref` in the no-param `forwardRef` case (the same clash, fixed here).
- **Destructured, no forwarding when unsafe.** After the move the pattern's defaults run inside the body and its
  names become body bindings. So if `ownBody(...).bound` (names declared anywhere in the body outside nested
  functions) holds a name the pattern binds (`var label` beside `{label}` would become a `const`/`var` SyntaxError)
  or an identifier the pattern reads (a default `= fallback` would see a body `const fallback`) → return `[]`, like
  `ShadowedProps` in 3.11.
- **Edits.** Roots get their spreads / dev fragment wrapper with `props` exactly as today. Then, only when some helper
  was used (as today's `__props` insert), the destructured case does:
  - `patternEnd`: `pattern.end`, or, when the pattern has a `typeAnnotation` or is `optional`, the last `}` / `]`
    before the annotation that is in no comment (oxc's pattern span includes `: Props`).
  - `appendLeft(start, name)`, then `text.move(start, patternEnd, at)`: the pattern text is moved, never re-printed,
    so defaults, rest, comments and mappings stay. The annotation and a parameter default stay on `__props`:
    `({a}: P = {})` → `(__props: P = {})`.
  - Block body: `at = body.start + 1`; `appendLeft(at, 'const ')`, `appendLeft(patternEnd, ' = __props;')`. No
    newline is added, so later lines keep their numbers:
    `function ScopedBadge(__props: Props) {const {label, className = ''} = __props;` ...
  - Expression body: `at = body.start`; `appendLeft(at, '{const ')`, `appendLeft(patternEnd, ' = __props; return ')`,
    and `appendLeft(body.end, '}')` after the root edits, so a dev fragment wrapper `(…)` closes first:
    `(__props: P) => {const {branch} = __props; return (<p …/>)}`.
  - The `forwardRef` second parameter (`({branch}, ref)` → `(__props, ref)`) stays as written. `Function.length` is
    unchanged in every form.

### 2. Fixtures (`<react>` only; props `{branch?: string}` unless noted; root `className="shape"` holding a `<span className="inner">`, as in 3.11)

- `packages/e2e/fixtures/components/react/shapes/`:
  - `Destructured.ucf`: `export default function Destructured({branch}: Props)`, block body.
  - `DestructuredArrow.ucf`: `export default ({branch}: {branch?: string}) => (<p …>)`.
  - `DestructuredDefaults.ucf`: `type Props = {branch?: string; label?: string; note?: string}`,
    `function DestructuredDefaults({ /* shown without a label */ label = 'default label', branch, ...rest }: Props = {})`,
    inner text `{label} / {branch} / {rest.note ?? 'no note'}` (rest is read, not spread, so the scope id cannot
    reach the root through it).
  - `ForwardRefDestructured.ucf`: `forwardRef<HTMLDivElement, Props>(({branch}, ref) => <div ref={ref} …>)`.
- `packages/e2e/fixtures/components/react/forwarding/` (build only):
  - `PropsClash.ucf`: module-level `const __props` and `const __props1`, read in the body → `__props2`.
  - `RedeclaredPattern.ucf`: `{label}` plus `var label` in the body → no forwarding.
  - `DefaultReadsBody.ucf`: `{tone = fallback}`, a module `const fallback` and a body `const fallback` → no forwarding.
  - `ThisParam.ucf`: `function ThisParam(this: void, props: Props)` → forwards `props`.
  - `RestParams.ucf`: `function RestParams(...args: [Props])` → no forwarding.
- `packages/e2e/fixtures/components/react/ScopedBadge.ucf`: no style of its own (the spec 3.5.1 case),
  `export default function ScopedBadge({label, className = ''}: Props)`,
  root `<span className={className}><em className="badge-label">{label}</em></span>`.
- `packages/e2e/fixtures/components/react/ScopedPanel.ucf`: imports `./ScopedBadge.ucf` (no attribute),
  `<section className="panel"><h2>…</h2><ScopedBadge label="new" className="badge" /></section>`; `<style scoped>`
  `.badge { color: rgb(30, 120, 60) }`, `.badge-label { text-decoration: underline }` (must not reach the inner `em`).
  The pair 3.14's demo and the exit test use.
- `packages/e2e/fixtures/apps/react-scope/Parent.ucf`: new cases `Destructured:only`, `DestructuredArrow:only`,
  `DestructuredDefaults:defaults` (`branch` only), `DestructuredDefaults:given` (`label="given label" note="rest note"`),
  `ForwardRefDestructured:only` (second `useRef`; the effect sets `data-ref` on both refs).
- `react-scope/src/main.tsx`: `?page=panel` renders `<ScopedPanel />` (its own console), other pages unchanged.

### 3. Test helper `packages/core/test/blocks/injected.ts`

- `withoutInjected` also undoes the move: for a function whose first parameter (or its `AssignmentPattern` left) is
  `__props\d*` and whose body starts with `{const <pattern> = <that name>;`, it puts the pattern text back in place of
  the name and removes the statement; for the arrow block form (`{const …; return <expr>}`, nothing between) it also
  removes the braces and `return `. That function's parameters are then not taken for an inserted no-param `__props`.
  Edits become `[start, end, replacement]`.
- No-param detection reads `__props\d*` / `__ref\d*`.

## Tests

- **`packages/core/test/react/scope.spec.ts`** (core project: this host, CI `check` and `react-floor`):
  - `SHAPES` rows for every new `shapes/` and `forwarding/` fixture: `roots`, `props` (`__props`, `__props2` for
    `PropsClash`, `props` for `ThisParam`) and a `signature` with the exact rewritten text (`(__props: Props) {const …
    = __props;`, `=> {const … = __props; return (`, `(__props: Props = {})`, `(__props, ref) => {const`). The
    table-completeness test catches a missing row.
  - Per shape: in the dev build, the moved pattern's first character maps (hires map, `@jridgewell/trace-mapping`) to
    the line and column where the source wrote it (rows whose build destructures).
  - "only inserts" also covers the move, through the extended `withoutInjected`, dev and production.
  - `react/ScopedPanel.ucf` joins `SCOPED` (the sweep finds it); `react/ScopedBadge.ucf` joins the unscoped cases
    beside `AllBlocks.ucf`. Snapshots of every destructuring fixture now show `__props`; each change reviewed.
- **`packages/core/test/blocks/react.spec.ts`**: 3.5 snapshots updated; "adds nothing else" and the token-mapping rows
  keep passing.
- **`packages/e2e/browser/react-scope.spec.ts`** (area: browser; this host via `MULTIFRONT_CHROMIUM_PATH` in `.env`, CI
  `check` and `react-floor`; Chromium is there since 3.9, no new infra), dev and preview:
  - The five new cases join `FORWARDED`: one root carrying `data-v-<Parent id>`, the parent's color, an `.inner`
    without it. `ForwardRefDestructured`'s root has `data-ref`.
  - Defaults and rest render as written: `DestructuredDefaults:defaults` inner text `default label / defaults / no note`,
    `:given` `given label / given / rest note`.
  - `?page=panel`: ScopedBadge's root span carries ScopedPanel's `data-v-<id>` and gets `rgb(30, 120, 60)`; its
    `em.badge-label` has no panel id and `text-decoration-line: none`; the label text shows; no console warning or error.
- Every other build or SSR test that renders a destructuring fixture (`react-target.spec.ts`, `imports.spec.ts` SSR,
  `react-render.spec.ts`) runs unchanged and stays green.

## Docs

- `docs/spec.md` 3.5, item 4: the pattern moves as written into `const <pattern> = __props;` at the top of the body (an
  expression-bodied arrow gets `{const … = __props; return …}`); the annotation and a parameter default stay on
  `__props`; `__props` / `__ref` take the first name no identifier of the block uses (`__props1`, ...); a body that
  declares a name the pattern binds or reads gets no forwarding, nor does a rest first parameter. Item 3: a TS `this`
  parameter is skipped.
- `docs/architecture.md`, `docs/plan.md`: none (no structure or decision change).
- Milestone doc: step 3.12 text matched to what ships (the fixtures above, `?page=panel`, the exact insert strings,
  which 3.13's rule 2 lists), `- Status: done`.
- Public docs: none (the milestone's docs writer).

## Fuzzing

None here: 3.13 owns the scope fuzz (its generator already toggles "destructured, plain or no props").

## Out of scope

- Fuzz (3.13), demo (3.14), HMR (3.15). Rest first parameters, class components, HOCs other than `memo` /
  `forwardRef`, non-JSX roots.

## Done when

- Every test above passes on this host and in CI `check` and `react-floor`.
- `pnpm devx check` passes; snapshot changes reviewed.
- Spec and milestone doc updated; this todo moved to `docs/done/` matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Decisions

- Orchestrator (approved): the TS `this` parameter bug is fixed here, own commit, `forwarding/ThisParam.ucf`.
- Orchestrator (approved): a name clash counts any identifier of the block; `__ref` follows the same rule.
- Orchestrator (approved): a body that declares a name the pattern binds or reads gets no forwarding.
- Orchestrator (approved): a rest first parameter keeps no forwarding, documented.
- Orchestrator (approved): ScopedPanel renders on its own page, `?page=panel`.
- Orchestrator (approved): no fuzz oracle here; 3.13 owns the scope fuzz.

## As shipped

- `forwarding/RestParams.ucf` pins the rest first parameter (no forwarding); the code check for it existed before.
- 3.5's `react.spec.ts` gained `ScopedBadge` and `ScopedPanel` rows (its table must list every `react/` fixture);
  its "adds nothing else" test now also strips stamps, as `ScopedPanel` is the first scoped `react/` fixture there.
  The `ScopedBadge` token row pins the moved pattern's mapping.
- `react-scope`'s shapes page now waits for `ForwardRefDestructured`'s ref, set in the same effect as `ForwardRef`'s.
- Review fixes:
  - The unsafe-move check compares the body's names with what the moved text binds or reads (`patternReads`: its
    names, defaults and computed keys), never a plain key or the annotation, so `{className: extra}` beside a body
    `const className` still forwards (`forwarding/RenamedKey.ucf`).
  - A later parameter that reads a pattern name (`({size}, scale = size)`) gets no forwarding
    (`forwarding/LaterParamReads.ucf`).
  - In a body that opens with directives (`'use no memo'`), `const ` goes before the first other statement, so the
    directive stays first (`forwarding/DirectiveBody.ucf`).
  - The fresh-name fix for the added `__props` / `__ref` is its own commit, with `forwarding/RefClash.ucf`
    (`(__props1, __ref1)`).
  - More edges pinned: `forwarding/OnlyThis.ucf`, `forwarding/ArrayPattern.ucf` (array, optional, a `]` in a comment
    before the annotation), `forwarding/DestructuredFragment.ucf` (moved in dev for the warning, left in place in
    production), and `DestructuredDefaults.ucf`'s pattern spans lines.
  - The SHAPES rows derive the moved pattern from their `signature`; 3.5's "adds nothing else" strips stamps only
    for a scoped case.
