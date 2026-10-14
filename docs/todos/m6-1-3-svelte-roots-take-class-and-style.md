---
type: feature
spec: full-plan
status: ready
created: 2026-10-14
milestone: 6.1
step: 6.1.3
---

# Svelte roots take class and style

## Problem

A parent styles a `.ucf` child by `className` / `style` in React (spec 3.5 item 5) and by `class` / `style` in Vue
(native fallthrough). A Svelte parent cannot: the forwarded Svelte root takes only the `data-v-*` scope props
(`packages/core/src/svelte/forward.ts:155-160`), and its types reject `class` (svelte2tsx types the props from the
`$props()` annotation, e.g. `{label: string}`). So `consumer-sveltekit` passes neither, and
`packages/e2e/consumer/exit.spec.ts` skips the check with `target !== 'svelte'`.

Related bug on `main`, fixed here (same import line): the Svelte build imports its helpers under their plain names,
ignoring names the block uses (`forward.ts:161,174`, `blocks/svelte.ts:266`). A block declaring
`const __ucfScopeAttrs = 1` builds to `import {__ucfScopeAttrs} …` plus that const, and Svelte fails with
"Identifier '__ucfScopeAttrs' has already been declared". The new merges make it common: the `$style` local is
already named `__ucfStyle`, the style merge's name.

## Plan

### 1. Shared merge helpers (`packages/core/src/react/scopeHelper.ts:39-44`)

Same names, now taking Svelte values too. With no parent value the root's own comes back unchanged.

- `__ucfClass(own, extra)`: two strings → joined with a space (React, unchanged); else `[own, extra]`, a Svelte
  `ClassValue` that Svelte's own `clsx` flattens (`class={expr}` compiles to `$.clsx(expr)`).
- `__ucfStyle(own, extra)`: two strings → `` `${own}; ${extra}` `` (the parent's declarations come last, so its keys
  win); else the object spread (React, unchanged).
- The library already ships these in `_ucf/scopeAttrs.js` (`scopeHelperCode(false)`).

### 2. Helper locals never clash (`forward.ts`, `blocks/svelte.ts`, `svelte/library.ts`)

- Each helper the Svelte build calls gets its local from `freshName(used, name)` after the class map locals:
  `import {__ucfScopeAttrs, __ucfStyle as __ucfStyle1} from …`.
- `forwardScope` returns import specifiers in place of bare names; the app import and `libraryImports` join them.

### 3. Root props in the build (new `packages/core/src/svelte/rootProps.ts`, called from `forwardScope`)

Only on the roots that get the scope spread: runes mode, at most one root per branch, element or component roots.
Legacy mode, several roots, an `{#each}` root and undecided blocks get nothing new; their dev warning is unchanged.

`R` = the props name the spread reads (existing rest, `let props = $props()`, added `__ucfRest`, `$derived` alias).

**The author wins.** A prop is left alone when:

- the `$props()` pattern has the key (`class: klass`, `'class': c`, `style`);
- the props object (the `$props()` identifier or the pattern's rest) is read with that key anywhere in the instance
  script or markup (`props.class`, `props?.class`, `props['style']`, `const {style} = props`), shadowed names
  included;
- a root spreading the props object or the rest (`{...props}`, `{...rest}`) gets neither prop.

**Edits per root and prop** (`style` the same with `__ucfStyle`):

| Own attribute | Build output |
| --- | --- |
| none | ` class={R.class}` right after the scope spread, before every author attribute |
| `class={expr}` | `class={__ucfClass(expr, R.class)}`, insert only |
| `{style}` shorthand | `style={__ucfStyle(style, R.style)}` |
| `class="a b"`, text only | `class={__ucfClass("a b", R.class)}`: JSON of Svelte's decoded `data` |
| `class="a {b} c"` | `` class={__ucfClass(`a ${b ?? ''} c`, R.class)} ``: Svelte's own stringify; tag sources stay in place |
| `class` with no value | left as written |

- `class:x` / `style:x` directives untouched: Svelte applies them on top (a root's `style:color` beats the parent).
- `escapeOnce` skips attributes these edits rewrote.

### 4. Root props in the types (same file, build AND editor)

Members `class?: import('svelte/elements').ClassValue | null` and `style?: string | null`, each only when some root
takes it.

- TS annotation on the `$props()` declarator → `(T) & {…}`.
- JS block, JSDoc `@type {T}` in the declaration's leading comment → `@type {(T) & {…}}`.
- No `$props()`: the added line is typed (TS annotation, or JSDoc in a JS script). Language = the first `lang` among
  the block's scripts, the added `<script lang="ts">` of library mode included.
- Unannotated `$props()`: no type edit; svelte2tsx infers, and the added rest makes it `& Record<string, any>`.
- The build always writes these edits: the library `.d.ts` comes from svelte2tsx over the shipped code.
- `renameSvelteStyles` is renamed `svelteEditorSource` (type `SvelteStyleRename` → `SvelteEditorSource`): the class
  map rename plus the build's `$props()` edits and these type edits, so editor and library `.d.ts` see one props
  type. Returns `lang: 'ts'` when it adds a `<script lang="ts">`.

## Decisions

Orchestrator's answers to the plan:

1. Fuzz: yes, extend the `forwards` rule of `packages/e2e/build/svelte-scope.fuzz.spec.ts` (milestones README: scope
   forwarding pinned by fuzz tests; root props ride on it).
2. Helper names `__ucfClass` / `__ucfStyle` reused for Svelte (spec 3.5: one helper module, bundled once).
3. Legacy, multi-root, `{#each}` and undecided components get nothing: same roots as the scope spread.
4. Shadowed reads count as handled; spec 3.6 says in one line that this differs from React's rule.
5. Unannotated `$props()` keeps svelte2tsx's inferred type (as React: no annotation keeps its own type).
6. Types: `ClassValue | null` for `class`, `string | null` for `style`, from `svelte/elements`.
7. `renameSvelteStyles` renamed to a name saying what it does (`svelteEditorSource`); every milestone doc naming it
   updated, no trace of the old name.

## Tests

All run here and in CI's `check` job (Chromium, tsserver already there); `consumer` job for the exit test;
`svelte-floor` (5.55.6) runs the Svelte ones again. No new infra.

1. Core build, new fixtures `packages/e2e/fixtures/components/svelte/root-props/` (`Merges`, `ReadsProps`,
   `Destructures`, `SpreadsRest`, `HelperClash`, `JsDoc`, `Untyped`, `Valueless`), new spec
   `packages/core/test/svelte/rootProps.spec.ts`: per root the state of `class` and `style`; the typed text from the
   build and from `svelteEditorSource`; compiles with no warning; code snapshot; server render with the parent's
   `class` / `style`, exact class list and style. `HelperClash` pins the aliased import (fails on `main`).
2. `packages/core/test/svelte/forward.spec.ts`: renders pass `class` / `style` too; forwarded roots hold them,
   nothing else does. Snapshots of `svelte/roots/` and `svelte/shapes/` updated; `undoBuild` / `HELPER_IMPORT` in
   `blocks/svelte.spec.ts` and the helper regex in `svelte/library.spec.ts` learn the new edits and aliases.
3. Browser parity: app `packages/e2e/fixtures/apps/root-props/` (`Parent.ucf` with three blocks, scoped `.extra`
   rule; children library `Button.ucf` and new shared `components/Note.ucf`). New
   `packages/e2e/browser/root-props-parity.spec.ts` on build + preview and dev: Svelte computed styles, sorted class
   lists and `data-v-*` equal React's and Vue's; no console problem.
4. Editor: `packages/e2e/editor/svelte-root-props.spec.ts`, tsserver with our plugin on `Parent.ucf`: no error;
   probes take `class` / `style`; `style={1}` is an error; components with no forwarding reject `class`.
5. Library types: `packages/e2e/fixtures/library-checks/svelte.ts` passes `class` / `style` to Button, plus a
   `@ts-expect-error` `style: 1`.
6. Consumer: `consumer-sveltekit` passes `class="extra" style="color: red"`; `exit.spec.ts` drops its Svelte skip.
7. Fuzz: the `forwards` rule's parent also passes a class and a style; every forwarded root holds them, nothing else.

## Docs

- `docs/spec.md`: 3.5 item 5 + helpers bullet (string / array merges shared with Svelte); 3.6 "Root props" bullet
  (incl. the shadowing difference); section 5 (the Svelte virtual script carries the root props); section 8 (one
  styling rule for every framework).
- `docs/architecture.md`: helper module's merges cover Svelte; the `<svelte>` editor code carries the root-prop types.
- `publicdocs/03-styles.md` forwarding table; `publicdocs/02-component-files.md` root props section names Svelte.
- `docs/milestones/m5-svelte-target.md`: the renamed function. Milestone doc: `- Status: done`.

## Out of scope

Legacy / multi-root / `{#each}` / undecided Svelte components; a warning about a dropped class or style; Svelte
`ref` / `bind:this`; Vue (native); `v-bind()` in CSS.

## Done when

- A Svelte parent passes `class` and `style` to a `.ucf` child and Chromium matches the React and Vue runs, in an
  app and through the library build; editor and library `.d.ts` type both, `style={1}` is an error.
- `exit.spec.ts` runs the Svelte check with no skip; a block naming a helper builds.
- `pnpm devx check` green, `pnpm exec vitest run` in `packages/core` green.
- The simplify-comments pass ran on every touched source file, committed on its own.
