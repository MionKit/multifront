---
type: feature
spec: full-plan
status: ready
created: 2026-10-10
milestone: 3
step: 3.10
---

# Milestone 3.10: Scope transform, stamping

## Problem

`react.build` (3.5) hands plugin-react the `<react>` block plus its style imports. A `<style scoped>` compiles to
`.box[data-v-<id>]`, but no React element carries that attribute, so scoped rules never apply. Vue's rule, "every
element in the template carries the scope id", needs a React twin: every JSX opening element in the block gets
` data-v-<scopeId>=""`, fragments excepted (react-dom 19.3 warns
``Invalid prop `%s` supplied to `React.Fragment` `` on any Fragment prop but `key`, `ref`, `children`).
Root forwarding (3.11) and destructured props (3.12) are not part of this step.

## Plan

### 1. `packages/core/src/react/reactApis.ts` (new)

- The one file that names React APIs (milestone "Hands to later milestones"):
  `REACT_MODULE = 'react'`, `FRAGMENT = 'Fragment'`, `WRAPPERS = ['memo', 'forwardRef'] as const`
  (named by the step text; read by 3.11, unused in 3.10).
- No other core file writes `'react'` or `'Fragment'` as a literal.

### 2. `packages/core/src/react/scope.ts` (new, internal: not exported from core's index)

- `stampScope(text: MagicString, program: Program, offset: number, scopeId: string): void`. `program` = oxc parse of
  `block.content`, `offset` = `block.contentStart`. Inserts only, so edits keep `.ucf` offsets and the map exact.
- Walks with core's `walk` (`packages/core/src/ast.ts`). Every `JSXOpeningElement` gets
  `text.appendLeft(offset + at, ` data-v-${scopeId}=""`)`, `at = (node.typeArguments ?? node.name).end`: after the
  type arguments of `<List<string> …>` (inside them would break the code; oxc gives `typeArguments` a span).
  Every name kind oxc gives: `JSXIdentifier` (`div`, `my-el`, `Foo`), `JSXNamespacedName` (`svg:x`),
  `JSXMemberExpression` (`Foo.Bar`, `this.X`).
- Never on fragments:
  - `<>` is a `JSXFragment`, not an opening element: the walk never sees it.
  - `<F>` where `F` is bound by `import {Fragment as F} from 'react'` (or plain `{Fragment}`).
  - `<R.Fragment>` where `R` is the default, namespace or `{default as R}` import of `'react'`, member path exactly
    `R.Fragment`.
  - Names come from module-level `ImportDeclaration`s; type-only imports do not count. Any other `Fragment` (a local
    object's `<Ui.Fragment>`, one imported elsewhere) is a component and gets stamped. A local binding shadowing the
    import is not followed (3.13's fuzz covers it).

### 3. `packages/core/src/blocks/react.ts`

- `build` parses `block.content` once when there are imports (as today); stamping needs a scoped style, so it never
  runs without them. `prologueEnd(block, filename)` becomes `prologueEnd(program)`, reading that same parse.
- `ctx.hasScoped` → `stampScope(text, program, block.contentStart, ctx.scopeId)` before the header insert.
- Builds without a scoped style are unchanged: 3.5's snapshots and its "adds nothing else" test stay as they are
  (no `BUILD_CASES` fixture has a scoped style).

### 4. Fixtures

- `packages/e2e/fixtures/components/react/scope/Stamped.ucf`, `<react>`:
  `import {Fragment, Fragment as Frag} from 'react'`, `import * as React from 'react'`,
  `const identity = <T,>(value: T) => value`, `const less = count < limit`,
  `const Foo = {Bar: …}` (root `<b className="member">`), lookalike `const Ui = {Fragment: …}`
  (root `<em className="lookalike">`), a generic component element (`<List<string> …>`), and
  `export default function Stamped()` with a `<>` root holding `<div className="box">`, `<p className="text">`,
  `<svg className="icon"><circle className="dot" …/><svg:x /></svg>`, `<my-el class="custom">`, `<Foo.Bar>`,
  `<Ui.Fragment>`, `<ul>{ITEMS.map((item) => <Fragment key={item}><li className="item">…</li></Fragment>)}</ul>`,
  `<Frag><span>…</span></Frag>`, `<React.Fragment><span>…</span></React.Fragment>`.
  One `<style scoped>` with a rule (distinct rgb color / fill) per `.box`, `.dot`, `my-el`, `.item`, `.member`,
  `.lookalike`.
  - Oxc's JSX transform logs a Vite build warning on namespace tags ("Namespace tags are not supported by default")
    but compiles them; inside `<svg>` React creates the element with no console warning.
- `packages/e2e/fixtures/apps/react-scope/`, the `react-basic` layout: `index.html` (empty icon, so no favicon 404),
  `src/main.tsx` rendering `<Stamped />` in `StrictMode` into `#app`, `vite.config.ts` with `react()` and
  `multifront()`. 3.11 adds `Parent.ucf` here.

### 5. Shared test helper

- `isInjected` and the strip-the-injected-imports loop of `packages/core/test/blocks/react.spec.ts` move to
  `packages/core/test/blocks/injected.ts` (`isInjected(node)`, `withoutInjected(code, program)`), used by
  `react.spec.ts` and the new `scope.spec.ts`.

## Tests

- **`packages/core/test/react/scope.spec.ts`** (core project; this host, CI `check` and `react-floor`).
  Cases: `react/scope/Stamped.ucf` and the existing scoped react fixtures `Badge.ucf`, `Button.ucf`, `Panel.ucf`,
  `ComposesScoped.ucf`, `ScopedModuleScss.ucf`, `TsxEdges.ucf` (`<T,>`, `a<b && c>d`, a `<>` root);
  `react/AllBlocks.ucf` as the unscoped control. Each through `splitBlocks` → `createBuildContext({root: FIXTURES_DIR,
  production: false})` → the registry's `react.build`. Checks:
  1. a code snapshot per fixture (`__snapshots__/react/scope/<fixture>.tsx.snap`);
  2. the output parses with oxc-parser, zero errors;
  3. inserts only: without every ` data-v-<id>=""` and the injected imports, the code is the block content;
  4. every output `JSXOpeningElement` carries exactly one `data-v-<id>` attribute valued `""`, except the hand-written
     fragment list of Stamped.ucf (`Fragment`, `Frag`, `React.Fragment`), which carry none; `Ui.Fragment` is stamped;
     the count of opening elements equals the input parse's; AllBlocks carries none;
  5. right after each stamp, the next character maps back through the hires map (`@jridgewell/trace-mapping`, already
     an exact-pinned root devDependency) to the `.ucf` line and column of that element's name (or type arguments) end.
- **`packages/e2e/browser/react-scope.spec.ts`** (area: browser; here with `MULTIFRONT_CHROMIUM_PATH` from `.env`, and in
  CI `check` and `react-floor`, which install Chromium since 3.9: no new infra). `react-scope` in `startDev` and
  `buildAndPreview`. Expected id = core's `scopeId(relative(appRoot, Stamped.ucf), source, production)`, not read back
  from the DOM.
  - Every element under `#app` has `data-v-<id>` as its only `data-v-*` attribute, the count equals a hand-written
    number; `#app` itself has none.
  - Scoped rules apply (computed styles): `.box`, `.item` color, `.dot` fill (svg), `my-el` color, `.member` and
    `.lookalike` color.
  - After `networkidle`, no `warning`, `error` or `pageerror` console entry (a stamped Fragment trips React's dev
    warning). Negative control by hand during the build, not committed: stamping fragments fails the dev run.

## Docs

- `docs/spec.md` 3.5, item 2: "Fragments (`<>`, React's `Fragment`) get nothing: React warns on extra Fragment props."
- `docs/architecture.md`, "Where the code lives": one line, React transforms in `packages/core/src/react/`, every React
  API name in `reactApis.ts`. Graphics unchanged.
- `docs/plan.md`: none (no decision changes).
- Milestone doc: step 3.10's Build line says "right after its name and type arguments"; `- Status: done`.
- Public docs: none (the milestone's docs writer).

## Fuzzing

None in this step: 3.13 owns the scope fuzz. Its rules 1 to 3 (parses, only adds, stamps) are Tests 2 to 4 above,
run here over every real scoped react fixture.

## Out of scope

- Root forwarding, `__ucfScopeAttrs` and its helper module (3.11); destructured props (3.12); fuzz (3.13); HMR (3.15).
- Following local bindings that shadow a `react` import. The editor's React script (not built by `react.build`).

## Decisions

- `WRAPPERS` (`memo`, `forwardRef`) goes in `reactApis.ts` now: the step's Build line names them there.
- The stamp goes after the type arguments (`<List<string> data-v-…="">`): "right after its name" would break generic
  elements. The step's Build line now says "right after its name and type arguments".

## Done when

- Both tests green on this host; the CI `check` and `react-floor` logs show `react-scope.spec.ts` executing.
- `pnpm devx check` passes; docs above updated; this spec moved into `docs/done/`, the milestone step marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
