---
type: chore
spec: full-plan
status: ready
created: 2026-10-11
milestone: 3
step: 3.13
---

# Milestone 3.13: Fuzz the scope transform

## Problem

`transformScope` (`packages/core/src/react/scope.ts`) stamps, forwards and moves props patterns. It is trusted on
hand-written fixtures only (the `shapes/`, `forwarding/`, `scope/` snapshots in `packages/core/test/react/scope.spec.ts`,
the browser shapes). The go / no-go (3.16, criterion 3) needs a seeded fuzz over shapes nobody wrote by hand, every
rule proven live by a broken output, failures shrunk, replayable, and saved as fixtures.

## Plan

### 1. Shared seeded harness `packages/e2e/build/lib/fuzz.ts`

Moved out of `packages/core/test/split.fuzz.spec.ts`, which imports it (relative path, as it does for
`e2e/fixtures/index.ts`); M6 6.7 builds on it.

- `fuzzSettings(defaults)`: `MULTIFRONT_FUZZ_SEED` (0..0xffffffff), `MULTIFRONT_FUZZ_RUNS` (>= 1), throws on a bad value.
- `mulberry32`, `mixSeed(base, label, index)`, `createRandom(seed)` (`next`, `int`, `pick`, `shuffle`).
- `shrinkActions(actions, stillFails)`: drops one action at a time while the case still fails.
- `replayLine(seed, runIndex, specPath)`.
- split.fuzz behaviour unchanged; its knob tests now test the shared `fuzzSettings`.

### 2. Generator `packages/e2e/build/lib/scopeFuzz.ts`

A case = a base fixture + a list of seeded actions (M1 shape). `caseAt(seed, runIndex)` is replayable;
`buildCase(fixture, actions, {name, render})` renders a small model into a real `.ucf` text. Every piece of text comes
from the fixtures, parsed once with oxc-parser.

- **Harvest**:
  - Header: `scope/Stamped.ucf`'s module-level statements (its react imports, `ITEMS`, `identity` with `<T,>`, `Foo`,
    `Ui`, `List`); Stamped's body consts `count`, `limit`, `less = count < limit` moved to module level; the other
    react import lines of `shapes/` (`memo`, `memo as memoized`, `forwardRef`);
    `import ArrowExpression from '<relative>/shapes/ArrowExpression.ucf'` (a forwarding component root);
    Unicode.ucf's `label` const and comment; Stamped's `<style scoped>` text.
  - JSX donors: every JSX element and fragment subtree of `shapes/*.ucf` and `scope/Stamped.ucf` whose free identifiers
    are in that module-level set (a small scope walk counts names bound by inner arrows, `.map((item) => <li key={item}>`,
    as bound). Parsed into a tree:
    `Element {tag, typeArgs, attrs: string[], children, selfClosing}`,
    `Fragment {form: '' | 'Fragment' | 'Frag' | 'React.Fragment', attrs, children}`, `Raw {text}` (JSX text and
    expression containers as written).
  - `scope/Namespaced.ucf` donors (`svg:x`) only in files rule 4 never renders.
  - `scope/FragmentImports.ucf` left out: its shadowing bindings change which names are Fragment, which the model does
    not track; its own snapshot test stays.
  - Comments: every comment of `shapes/`, `forwarding/`, `scope/`, Unicode.ucf.
- **Base model**: `export default function Fuzz<n>(props: { branch?: string }) { return <first donor of the base fixture> }`
  with the header and a `<style scoped>`.
- **Actions** (each with `applicable(model)`; `replay` skips one that no longer applies, so shrinking can drop any):
  - `memo`, `forwardRef` (wrap; both, either order; callee `memo` / `memoized` / `React.memo`, `forwardRef` /
    `React.forwardRef`, sometimes with the fixtures' type arguments);
  - `arrow` (function / arrow); `expression-body` (rendered as an expression only for an arrow with one return and no
    const root);
  - `props`: plain `props` / destructured (`{ branch }`, `{ branch, ...rest }`, `{ /* comment */ branch }`, `= {}`
    parameter default, from DestructuredDefaults) / none. Inside forwardRef always 0 or 2 parameters:
    `(props, ref)`, `({ branch }, ref)`, `()`;
  - `export-style`: `export default <expr>` / `const Fuzz<n> = …; export default Fuzz<n>` / `export { Fuzz<n> as default }`;
  - `generic`: `<T,>` on an arrow, `<T>` on a function;
  - `early-return`: `if (<guard>) return <donor | null | 'text'>`;
  - `ternary` (`<guard> ? (<donor | null>) : (<expr>)`), `and` (`<guard> && <expr>`), `parens`, on a return's expression;
  - `const-root`: `const root<k> = <expr>; return root<k>` at the body's top level (3.11's one hop);
  - `swap-tag`: host → component (`ArrowExpression` self-closing, forwards; `Foo.Bar` / `Ui.Fragment` keep children, drop
    the prop; `List<string> items={ITEMS}`), component → a host tag from the fixtures. A swap keeps only `className` and
    `key`, so React never warns about an attribute;
  - `splice-child`: a donor subtree into an element's or fragment's children;
  - `comment`: at a body statement (a line comment gets its newline), between the function name and `(`, inside a
    destructured pattern, or a JSX child `{/* */}`; block comments only and never after `return`, so ASI never changes
    the code;
  - `less-than`: a guard gets `&& count < limit`;
  - `unicode`: a non-ASCII text child, or Unicode.ucf's comment and const before the component;
  - `use-client`: `"use client"` first; `scoped`: `<style scoped>` / `<style>`.
- Guards: `props.branch === 'b<k>'` / `branch === 'b<k>'`; with no props a constant: `count < limit` (true) or
  `limit < count` (false).
- **Records** what it built, so the checks never redo the transform:

  ```ts
  interface ScopeCase {
    name: string; fixture: string; actions: Action[]; applied: ActionKind[]; source: string;
    render: boolean;      // runIndex % 20 === 0; such a case never gets a namespace tag
    scoped: boolean;
    props: string;        // the name the forwarding reads: 'props' or '__props'
    fragments: string[];  // tag names that are React's Fragment here: '', 'Fragment', 'Frag', 'React.Fragment'
    branches: {branch?: string; outcome: 'host' | 'forwarding-component' | 'dropping-component' | 'fragment' | 'none'}[];
  }
  ```

  `branches`: each guard value plus `'other'`; with no props one entry without a branch.
- `writeCase(dir, case)` writes `<dir>/<name>.ucf`. Fuzz files go to `packages/e2e/.tmp/fuzz/<mkdtemp>/` (`.tmp/` is
  gitignored), removed after a green run, kept after a failure (the message names it).

### 3. Rules and runner `packages/e2e/build/scope-fuzz.spec.ts`

Each case first passes `checkBlocks` with zero diagnostics (rule `valid-input`: a red there is a generator bug). Built
in-process in dev and in production: `splitBlocks` → `createBuildContext` (`loadVueCompiler`, root = fuzz dir) →
`getBlockKind('react').build`.

1. **parses**: each output parses with oxc-parser with zero errors.
2. **only-adds**: from the hires map (`@jridgewell/trace-mapping` `decodedMappings`; magic-string gives each original
   character a segment, except line breaks). The mapped output characters, sorted by `.ucf` offset, are exactly the
   block content's non-line-break characters, once each, each the same character. Each run of unmapped output
   tokenizes fully into the fixed inserts (` data-v-<id>=""`, ` {...__ucfScopeAttrs(<props>)}`,
   `(__ucfWarnFragment(<props>, "<name>"), `, `)`, `<props>`, `<props>, __ref`, `const `, `{const `, ` = <props>;`,
   ` = <props>; return `, `}`, `import "<style id>";`, `import <name> from "<class map id>";`,
   `import {…} from "virtual:multifront/scope-attrs";`) and `\n`. Line breaks are counted: those left over = the
   content's line breaks + the import tokens.
3. **stamps**: the output's opening element names equal the input's, in order; with a scoped style each element not in
   `fragments` carries exactly one ` data-v-<id>=""` and fragments none; without one, nothing is stamped.
4. **renders** (`render` cases): one real Vite dev server per spec run (`configFile: false`, root = fuzz dir,
   `plugins: [react(), multifront(), breaker]`, middleware mode, `ws: false`, `preTransformRequests: false`,
   `optimizeDeps.noDiscovery`). A real entry `<name>.render.tsx` imports the case and exports
   `render(branch?) => renderToString(<main><Case data-v-parent="" branch={branch} /></main>)`, loaded through the SSR
   environment's `runner.import`, rendered once per branch. The first element inside `<main>` carries
   `data-v-parent=""` exactly when the outcome is `host` or `forwarding-component`. Every `console.error` /
   `console.warn` of the import and the render (captured by swapping them meanwhile) is our
   `[multifront] <name> renders a fragment root` warning, on a fragment branch only.

Runner: settings default `{seed: 2026, runs: 300}`; stops at the first failing case, shrinks it with `shrinkActions`
(same rule still failing; candidates keep `render`). The assertion message: the replay line
`MULTIFRONT_FUZZ_SEED=<s> MULTIFRONT_FUZZ_RUNS=<i+1> pnpm devx test packages/e2e/build/scope-fuzz.spec.ts`, the
actions, the shrunk source, the kept directory. Timeout `60_000 + runs * 100` ms.

### 4. Saving failures

Each failure the fuzz finds during this step is fixed in `scope.ts` (own commit); its shrunk case goes to
`packages/e2e/fixtures/components/react/fuzz-found/<Name>.ucf` with a hand-read `SHAPES` row (and a `SCOPED` row if
scoped) in `packages/core/test/react/scope.spec.ts`, whose listing test gains `react/fuzz-found`. No failure, no folder.

### 5. Dependency

`oxc-parser` becomes a root devDependency, exact `0.149.0` (core's): `packages/e2e` cannot resolve it today, and test
tools are root devDependencies.

## Tests

All run on this host and in CI (`check` and `react-floor` jobs, `pnpm devx test`). No new infra: real Vite,
plugin-react and react-dom/server are there.

- `holds every rule over 300 generated files (seed 2026)`.
- `reaches every case` (default seed, generator only): every action applied, every outcome kind in rendered cases,
  each wrapper combination, function / arrow × block / expression, every props form and export style, scoped and not.
- `shrinks to the fewest actions that still fail` (fixed actions, a synthetic predicate).
- Negative controls (`it.each`): the real output through a breaker (in-process for rules 1 to 3; for rule 4 in the
  test's `breaker` plugin, enforce `pre` after `multifront()`, on `.ucf.react.tsx`). The fuzz with only that rule
  fails, the shrunk case still fails, a replay of `runIndex + 1` runs gives the same input. Breakers:
  1. parses: a forwarding spread left open;
  2. only-adds: a stray `/*x*/` after a stamp; a dropped character after a stamp;
  3. stamps: the last stamp missing; a doubled stamp;
  4. renders: every spread removed; `className=` turned into `class=` (React's server renderer warns, checked here).
- Long run before the PR, result in the PR: `MULTIFRONT_FUZZ_RUNS=10000` over seeds 2026 and 1 to 9. 3.16 repeats it
  for the verdict.

## Docs

- `scripts/lib/env.mjs`: `MULTIFRONT_FUZZ_RUNS` desc "inputs per fuzz test (default 500 splitter, 300 scope)";
  `.env.sample` comment to match.
- `SETUP.md` fuzz line: the scope fuzz replay example.
- m3 milestone doc: `- Status: done` on 3.13; step text to what ships (rule 4 rendered through a real Vite dev server's
  SSR module runner with real plugin-react; `build/lib/fuzz.ts`); "Hands to later milestones" fuzz row names
  `packages/e2e/build/lib/fuzz.ts` and `scopeFuzz.ts`.
- m7 doc names `components/fuzz/` for saved fuzz cases: becomes `components/react/fuzz-found/`.
- No spec, architecture, plan or publicdocs change: test only.

## Fuzzing

This step is the fuzz test (fuzzy-testing skill: rules grounded in 3.10 to 3.12's own tests, a negative control each).

## Out of scope

The 10-seed verdict run itself (3.16), a soak workflow, browser rendering of fuzz files, FragmentImports' shadowing
forms, Svelte (M6), any transform change not forced by a fuzz failure.

## Done when

- The spec passes in `pnpm devx check` and in CI; the CI log shows its tests executing.
- Every negative control green; the long run green; each found failure fixed, saved under `fuzz-found/`, snapshot row.
- Docs above updated.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Decisions

- Shared harness in `packages/e2e/build/lib/fuzz.ts`, split.fuzz switches to it (orchestrator: M6 builds on M3's harness).
- Four rules only; a fifth "forwards" rule over recorded root offsets dropped (orchestrator: the step lists four).
- Rule 4 through a dev server's SSR module runner, not `vite build --ssr`: the fragment warning and React's own warnings
  exist in dev only (orchestrator: approved).
- `type: chore`: a test-only step, as M1.5 (orchestrator: approved).
