---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.5
---

# Milestone 6.5: Root props in the React types

## Problem

6.4 makes every React root take `className`, `style` and `ref` from the parent at runtime (spec 3.5, item 5). The editor
still types the default export with the author's props only, so `<Button label="Press" className="extra"
ref={buttonRef} />` in `fixtures/apps/react-root-props/src/App.tsx` is an error in tsserver even though it works. The
6.6 `.d.ts` files are emitted from the same `Card.ucf.react.tsx` script (`getTypesScript`), so they would miss the props
too.

Today the script is the block content mapped 1:1, plus the `$style` declarations
(`packages/language-tools/src/blocks/react.ts:8-16`). Which roots get which prop is only known inside core's scope
transform (`packages/core/src/react/scope.ts:220`, `rootProps.ts:53-123`). Language-tools has no parser of its own.

Checked with real `tsc` and React 19 types: `ref?: Ref<ComponentRef<'button'>>` in the props accepts
`createRef<HTMLButtonElement>()` and rejects `createRef<HTMLDivElement>()` (2322). `forwardRef<El, P & X>` and
`memo(forwardRef<El, {} & X>(…))` accept `className`.

## Decisions

- Orchestrator (approved): no fuzz rule. The 6.5 Test line names only the editor test, and the core `SHAPES` table
  checks the analysis against the build output on every fixture.
- Orchestrator (approved): a parameter with no annotation and no wrapper type argument is left alone. An unannotated
  `props` is already `any`; an unannotated pattern already errors under `strict` (7031).
- Orchestrator (approved): the analysis is one shared function in core (`reactRootProps`), so the editor and the build
  cannot disagree.

## Approach

Write the extra props into the props type where it is declared, so the default export stays the same declaration
(go-to-definition, rename and references from importers keep working):

- `function Button({label}: {label: string})` → `{label: string} & {className?: string; style?: …; ref?: …}`.
- A wrapper with explicit type arguments gets it too: `forwardRef<HTMLDivElement, P>` → `P & X`,
  `forwardRef<HTMLDivElement>` → `<HTMLDivElement, X>`, `memo<P>` → `P & X`.
- No parameter: `function Card()` → `function Card(__props: X)` (the build's name; a leading `_` keeps
  `noUnusedParameters` quiet in 6.6's `tsc`).
- A parameter with no annotation and no wrapper type argument gets nothing: its type is `any` (or the pattern's own),
  which the author chose.

`X` holds only the props some root takes (added or merged at runtime): `className?: string`,
`style?: import('react').CSSProperties`, `ref?: import('react').Ref<…>`. The ref type is the union, one per root that
takes `ref`, of `import('react').ComponentRef<'tag'>` for a host tag (lowercase first letter, as React reads it) and
`Element` for anything else (a component, `motion.div`). A prop the author handles, and every prop on a root that
spreads `props`, is left to the author's type: the same rule as 6.4, from the same code.

## Plan

### 1. Core: one analysis for the build and the types (`packages/core/src/`)

- `react/scope.ts`: the analysis part of `transformScope` (`:234-261`: `findComponent`, the `this` / rest / bound /
  pattern bail-outs, the props name, `handledRootProps`, `jsxRoots`) moved into an internal `analyzeComponent(program)`.
  `transformScope` calls it and applies the edits as before; no output change.
- `findComponent` (`:98`) also returns the wrapper calls it went through (`{api: 'memo' | 'forwardRef', call}`).
- `react/rootProps.ts`: `addRootProps` (`:78`) split into `rootPropEdits(opening, handled)` (pure: per prop `add`,
  `merge`, `mergeString` or nothing, exactly the old branches) and `addRootProps`, which applies them.
- `react/scope.ts`: `rootPropsOf(parsed, content)` gives each element root once, in source order, with its tag as
  written and the props it takes, plus the props type sites. `propsTypeInserts(site, type)`, exported from
  `@multifront/core`, turns one site into the text inserts that type it, so the editor and the core test share it.
- `blocks/react.ts`: public `reactRootProps(block, filename): ReactRootProps | undefined`, exported from
  `@multifront/core`. It runs `rootPropsOf` over the block's cached parse (`parseBlock`, shared with `check` and
  `build`). `undefined` when the build forwards nothing. Types in `packages/core/src/types.ts`:

  ```ts
  type RootProp = (typeof ROOT_PROPS)[number]; // 'className' | 'style' | 'ref', from reactApis.ts
  interface ReactRoot {tag: string; props: RootProp[]} // tag as written; the props the parent's value reaches
  /** Where the default export's props type is written, as offsets in the block content. */
  type ReactPropsSite =
    | {kind: 'type'; start: number; end: number; wrap: boolean} // `& X` after it; `wrap`: parenthesized first
    | {kind: 'argument'; at: number} // `forwardRef<El>`: `, X` goes here
    | {kind: 'parameter'; at: number; name: string}; // no parameter: `name: X` goes right after the `(`
  interface ReactRootProps {roots: ReactRoot[]; sites: ReactPropsSite[]}
  ```

  `wrap` is set for a union, function, constructor or conditional type.

### 2. Language-tools: the types script (`packages/language-tools/src/`)

- `mappings.ts`: `insertMapped(block, inserts: {at: number; text: string}[]): {code: string; mappings: CodeMapping[]}`:
  the content split at each insert, every piece mapped 1:1 with `ALL_FEATURES`, the inserted text unmapped. With no
  insert it is the single content mapping of before.
- `blocks/react.ts` `types()`: `reactRootProps(block, ctx.split.filename)`; when some root takes a prop, build `X` and
  each site's `propsTypeInserts`, then `insertMapped`. The `$style` declarations follow, as before.

### 3. Fixtures

- `fixtures/apps/react-root-props/tsconfig.json` (new): the imports app's settings (`jsx: react-jsx`, `strict`,
  `moduleResolution: bundler`, our plugin with `framework: 'react'`), plus `allowImportingTsExtensions`
  (`main.tsx` imports `./App.tsx`).
- `App.tsx`: a `WrongRef` component, exported, never rendered: `useRef<HTMLDivElement>(null)` passed to `Button`, under
  `// @ts-expect-error`. The browser test renders `App` only, so it is unchanged.
- `components/react/root-props/UnionProps.ucf` (new): props typed `{kind: 'a'} | {kind: 'b'; note: string}`, one
  `<div>` root. Without the parentheses, `X` would join only the last member. Gets a row in core's `SHAPES` table.
- `components/react/root-props/MemoTyped.ucf` (new, from the review): `memo<{ branch?: string }>(…)`, the `memo` type
  argument site. A `SHAPES` row and a probe row. Not under `shapes/`: the scope fuzz draws its sources from there.

## Tests

All run with `pnpm devx test`: this host and CI's `check` job (tsserver is a child process; no new infra). The
`react-floor` job runs them on React 19.0's types; `ComponentRef` exists there.

- Core, `packages/core/test/react/scope.spec.ts`, per `SHAPES` row (every `forwarding/`, `root-props/`, `shapes/`,
  `fuzz-found/` fixture): `reactRootProps` gives the same roots, in order, with the tags the build output has, and per
  root exactly the props the build output added or merged (read from the output, as the existing root-props case
  does). Its sites: one row each checked by hand for the param annotation, the default value
  (`DestructuredDefaults`), `ForwardRef` (second type argument), `MemoForwardRef` (`argument` + `parameter`),
  `NoParams` (`parameter`), `UnionProps` (`wrap`), `MemoTyped` (`memo` type argument). The marked text is built with
  the shipped `propsTypeInserts`, not a copy of it.
- Editor area, `packages/e2e/editor/react-root-props.spec.ts` (new), real tsserver with the TypeScript plugin, cwd the
  react-root-props app:
  - `App.tsx` has no diagnostics: the valid `Button`, `Badge`, `Own` uses pass and the `@ts-expect-error` is consumed
    (an unused one would be 2578).
  - Without the directive (an unsaved edit), the only diagnostic is one 2322 on that line.
  - A table of unsaved probe lines appended to `App.tsx`, each with the errors expected (none, or 2322 on its line):
    `Badge` with `className` (author's) plus `style` and a `<span>` ref; `Own` with an `HTMLElement` ref and an
    `HTMLParagraphElement` ref (both fit: it renders a `<section>` or a `<p>`) and an `SVGSVGElement` ref (rejected);
    `shapes/ForwardRef`, `shapes/MemoForwardRef`, `shapes/Memo`, `root-props/MemoTyped`, `shapes/NoParams` and
    `shapes/DestructuredDefaults`
    with `className` and `style`; `NoParams` with a `<span>` ref (rejected); `shapes/ComponentRoot` with an `Element`
    ref (fits) and a `Text` ref (rejected); `root-props/SpreadsProps` and `root-props/Valueless` with `className`
    (rejected: left to the author), `Valueless` with `style` and a `<div>` ref; `UnionProps` with `kind="a"` plus
    `className` (passes only with the parentheses).
  - Probe refs are `createRef<…>()` objects: React types a callback ref's parameter bivariantly, so a callback typed
    for a narrower element is never rejected. A `<p>` ref fits a `<div>` root (the two are the same shape), so the
    rejected rows use `<span>`, SVG and `Text`.
  - Go-to-definition on `<Button` still lands in `Button.ucf`'s `<react>` block.
- Existing tests that change:
  - `editor/virtualCode.spec.ts`, "maps the whole block content…": a `<react>` code now has several content mappings.
    New check: the `ALL_ON` mappings cover the block content in order with no gap or overlap, and through Volar's
    mapper every content offset has a generated location holding the same character. The first location is no longer
    enough: at a split, it is the end of the piece before, where the inserted text starts.
    `UnionProps`, `MemoTyped` and `MemoForwardRef` join its fixture list, so a file with two inserts (and a wrapped
    one) has its mappings checked.
  - React code snapshots (`editor/__snapshots__/virtualCode/*.ucf.react.tsx`, `editor/__snapshots__/*.ucf.react.tsx`)
    are updated and read one by one.
  - `editor/styleClasses.spec.ts` took the `$style` key mappings as every mapping after the first; it now picks them
    by their data (navigation only), since the content can be several pieces.

## Docs

- `docs/spec.md` 3.5 item 5: one bullet. The editor and the `.d.ts` see the same props: the default export's props type
  gains those some root takes, the ref typed from the root tags. Section 6, "Per-target virtual scripts": the
  `Card.ucf.react.tsx` line says the root props are added.
- `docs/architecture.md`, "Inside a `.ucf` file": one sentence on the `<react>` code (block 1:1, plus `$style` and the
  root props written where core's `reactRootProps()` says).
- Milestone doc: the 6.5 Build line names `reactRootProps` in core; `- Status: done`. Under "Hands to later milestones",
  `reactRootProps` is added to the `needsUseClient` line.
- No `publicdocs/` page describes this yet.

## Fuzzing

Not a candidate: the core table checks the analysis against the build output on every fixture.

## Out of scope

- The `.d.ts` emit (6.6). Lint rules and `mf-tsc` (M7).
- Typing a parameter that has no annotation and no wrapper type argument.

## Done when

- The editor accepts `<Button className="x" ref={buttonRef} />` and rejects a `<div>` ref, as tested above.
- `pnpm devx check` passes. The spec is updated and moved into `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
