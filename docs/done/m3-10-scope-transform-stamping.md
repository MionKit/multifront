---
type: feature
spec: full-plan
status: done
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
- No other core file names the `'react'` module or `Fragment` as a literal.

### 2. `packages/core/src/react/scope.ts` (new, internal: not exported from core's index)

- `stampScope(text: MagicString, program: Program, offset: number, scopeId: string): void`. `program` = oxc parse of
  `block.content`, `offset` = `block.contentStart`. Inserts only, so edits keep `.ucf` offsets and the map exact.
- Walks the program with `children(node)`, split out of core's `walk` (`packages/core/src/ast.ts`). Every `JSXOpeningElement` gets
  `text.appendLeft(offset + at, ` data-v-${scopeId}=""`)`, `at = (node.typeArguments ?? node.name).end`: after the
  type arguments of `<List<string> …>` (inside them would break the code; oxc gives `typeArguments` a span).
  Every name kind oxc gives: `JSXIdentifier` (`div`, `my-el`, `Foo`), `JSXNamespacedName` (`svg:x`),
  `JSXMemberExpression` (`Foo.Bar`, `this.X`).
- Never on fragments:
  - `<>` is a `JSXFragment`, not an opening element: the walk never sees it.
  - `<F>` where `F` is bound by `import {Fragment as F} from 'react'` (or plain `{Fragment}`).
  - `<R.Fragment>` where `R` is the default, namespace or `{default as R}` import of `'react'`, member path exactly
    `R.Fragment`.
  - Names come from module-level `ImportDeclaration`s (one `Set`: `F` and `R.Fragment` keys); type-only imports
    (`import type`, `{type Fragment}`) do not count; a quoted `{'Fragment' as Q}` does (core's `keyName`). Any other
    `Fragment` (a local object's `<Ui.Fragment>`, one imported elsewhere) is a component and gets stamped.
  - A local binding that shadows an imported name is followed: the walk carries the shadowed names down. Bindings
    come from function names and parameters (any pattern), block and switch declarations (`const`, `let`, `var`,
    function, class), catch parameters and `for` heads. A `var` counts in its own block only.

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
  (root `<em className="lookalike">`), a generic `function List<Item>` used as `<List<string> items={ITEMS} />`, and
  `export default function Stamped()` with a `<>` root holding `<div className="box">`, `<p className="text">`,
  `<svg className="icon"><circle className="dot" …/></svg>`, `<my-el class="custom">`, `<Foo.Bar>`, `<Ui.Fragment>`,
  `<List<string> …>`, `<ul>{ITEMS.map((item) => <Fragment key={item}><li className="item">…</li></Fragment>)}</ul>`,
  and `<p><Fragment>…</Fragment></p>`, `<p><Frag>…</Frag></p>`, `<p><React.Fragment>…</React.Fragment></p>`.
  - Each named fragment is a sole child once: react-dom 19 checks Fragment props on mount only for a single child
    (and a keyed or unkeyed top-level fragment), never for array children. Siblings would hide a stamped Fragment.
  - One `<style scoped>` with a rule (distinct rgb color / fill) per `.box`, `.dot`, `my-el`, `.item`, `.member`,
    `.lookalike`, `.list`.
- `packages/e2e/fixtures/components/react/scope/Namespaced.ucf`: `<svg>` with two `<svg:x>` (self-closing and not)
  and a scoped style. Built only, by the core spec: React's JSX transform (Oxc) rejects namespace tags in a Vite build
  ("Namespace tags are not supported by default"; a dev transform only warns).
- `packages/e2e/fixtures/components/react/scope/FragmentImports.ucf`, built only (`./other` does not exist): `{default
  as R}`, `{'Fragment' as Quoted}`, `{type Fragment as SpecFrag}`, `import type {Fragment as TypeFrag}`, `* as React`,
  `{Fragment}` from `'react'`, `{Fragment as Other}` from `./other`; a `const Fragment`, a `React` parameter and an
  arrow parameter `Fragment` that shadow the imports.
- `packages/e2e/fixtures/apps/react-scope/`, the `react-basic` layout: `index.html` (empty icon, so no favicon 404),
  `src/main.tsx` rendering `<Stamped />` in `StrictMode` into `#app`, `vite.config.ts` with `react()` and
  `multifront()`. 3.11 adds `Parent.ucf` here.

### 5. Shared test helpers

- `isInjected` and the strip-the-injected-imports loop of `packages/core/test/blocks/react.spec.ts` move to
  `packages/core/test/blocks/injected.ts` (`isInjected(node)`, `withoutInjected(code, program)`), used by
  `react.spec.ts` and the new `scope.spec.ts`.
- `computed(locator, property)` moves from `react-render.spec.ts` into `packages/e2e/browser/lib/chromium.ts`, used by
  both browser specs.

## Tests

- **`packages/core/test/react/scope.spec.ts`** (core project; this host, CI `check` and `react-floor`).
  Cases: every fixture with a `<react>` block, a scoped style and no `checkBlocks` diagnostic (a first test scans
  `fixtures/components/` and fails when the list misses one): `Stamped.ucf`, `Namespaced.ucf`, `FragmentImports.ucf`
  (all in `react/scope/`), `Badge.ucf`, `Button.ucf`, `ComposesScoped.ucf`, `Panel.ucf`, `ScopedModuleScss.ucf`,
  `TsxEdges.ucf` (`<T,>`, `a<b && c>d`, a `<>` root), `invalid/CssSyntaxError.ucf`, `langs/PostcssPlain.ucf`,
  `langs/SassIndented.ucf`, `scoped-modules/ScopedModuleEdges.ucf`; `react/AllBlocks.ucf` as the unscoped control. Each through `splitBlocks` → `createBuildContext({root: FIXTURES_DIR,
  production: false})` → the registry's `react.build`. Checks:
  1. a code snapshot per fixture (`__snapshots__/react/scope/<fixture>.tsx.snap`);
  2. the output parses with oxc-parser, zero errors;
  3. inserts only: without every ` data-v-<id>=""` and the injected imports, the code is the block content;
  4. every output `JSXOpeningElement` carries at most one `data-v-<id>` attribute valued `""`; the ones without it,
     in source order, are exactly the hand-written `unstamped` list (Stamped.ucf: `Fragment`, `Fragment`, `Frag`,
     `React.Fragment`; FragmentImports.ucf: `R.Fragment`, `Quoted`, `Fragment`, `React.Fragment`, so its shadowed
     `Fragment` / `React.Fragment` and its type-only and `./other` imports are stamped); `Ui.Fragment` is stamped;
     the count of opening elements equals the input parse's; AllBlocks carries none;
  5. a stamp is always the first attribute, and right after it the next character maps back through the hires map (`@jridgewell/trace-mapping`, already
     an exact-pinned root devDependency) to the `.ucf` line and column of that element's name (or type arguments) end.
- **`packages/e2e/browser/react-scope.spec.ts`** (area: browser; here with `MULTIFRONT_CHROMIUM_PATH` from `.env`, and in
  CI `check` and `react-floor`, which install Chromium since 3.9: no new infra). `react-scope` in `startDev` and
  `buildAndPreview`. Expected id = core's `scopeId(relative(appRoot, Stamped.ucf), source, production)`, not read back
  from the DOM.
  - Every element under `#app` has `data-v-<id>` as its only `data-v-*` attribute, the count equals a hand-written
    number (19); `#app` itself has none.
  - Scoped rules apply (computed styles): `.box`, `.item`, `.list` color, `.dot` fill (svg), `my-el` color, `.member`
    and `.lookalike` color.
  - After `networkidle`, no `warning`, `error` or `pageerror` console entry (a stamped Fragment trips React's dev
    warning). Negative control run by hand, not committed: with fragments stamped, the dev run fails on three
    ``Invalid prop `data-v-…` supplied to `React.Fragment` `` errors.

## Docs

- `docs/spec.md` 3.5, under item 2: "Fragments (`<>`, React's `Fragment`) get nothing: React warns on extra Fragment props."
- `docs/architecture.md`, "Where the code lives": one line, React transforms in `packages/core/src/react/`, every React
  API name in `reactApis.ts`. Graphics unchanged.
- `docs/plan.md`: none (no decision changes).
- Milestone doc, step 3.10: "right after its name and type arguments", the fixture list (sole-child fragments,
  `Namespaced.ucf` and `FragmentImports.ucf` built only), the core spec's sweep over every scoped react fixture, `- Status: done`.
  Step 3.13: its render rule never renders `scope/Namespaced.ucf`'s namespace tags.
- Public docs: none (the milestone's docs writer).

## Fuzzing

None in this step: 3.13 owns the scope fuzz. Its rules 1 to 3 (parses, only adds, stamps) are Tests 2 to 4 above,
run here over every real scoped react fixture.

## Out of scope

- Root forwarding, `__ucfScopeAttrs` and its helper module (3.11); destructured props (3.12); fuzz (3.13); HMR (3.15).
- The editor's React script (not built by `react.build`).

## Decisions

- `WRAPPERS` (`memo`, `forwardRef`) goes in `reactApis.ts` now: the step's Build line names them there.
- The stamp goes after the type arguments (`<List<string> data-v-…="">`): "right after its name" would break generic
  elements. The step's Build line now says "right after its name and type arguments".
- Found while building, decided here (automatic mode): `<svg:x>` fails a Vite build with plugin-react, so it moved
  from `Stamped.ucf` (rendered) into `scope/Namespaced.ucf` (core build only). Smallest change that keeps namespaced
  names covered without changing plugin-react options in a fixture.
- Review: a local binding shadowing a `react` import is now followed (was out of scope): a shadowing `Fragment` got no
  stamp, so scoped rules silently missed it, and no later step owned it.
- Review: the build helper shared by `react.spec.ts` and `scope.spec.ts` stays apart: the two return different things
  (diagnostics vs `ctx`) and differ in `production`; a shared one saves no lines.

## Done when

- Both tests green on this host; the CI `check` and `react-floor` logs show `react-scope.spec.ts` executing.
- `pnpm devx check` passes; docs above updated; this spec moved into `docs/done/`, the milestone step marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
