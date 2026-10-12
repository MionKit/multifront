---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.2
---

# Milestone 5.2: the `<svelte>` kind, `build`

## Problem

`svelteKind.build` (`packages/core/src/blocks/svelte.ts:83-102`) parses the block, runs 5.1's rules, then always throws
`target-not-built` (`:100-101`). Vite's `load` already calls `buildTarget(split, ctx, 'svelte')`
(`packages/vite/src/index.ts:48-56`), so every svelte pick stops there. 5.2 returns the real `.svelte` file instead.

Checked on svelte 5.57.0 (scratch scripts):

- Modern AST: `Script.content.start` is the offset right after the opening `<script …>` tag. `root.options`
  (`<svelte:options>`) is not in `root.fragment`. Element nodes have `start` at `<` and `name` as written (`ui.Child`,
  `svelte:element`), so the name ends at `start + 1 + name.length`.
- `compile(…, {generate: 'server'})` gives no warning for: a `<script module lang="ts">` beside a plain `<script>`;
  unused imports, a bare `import '<css id>'`; `data-v-x=""` on `<svelte:element>`, a `Component`, legacy
  `<svelte:component>` and `<svelte:self>`, elements inside `{#if}`, `{#each}`, `{#await}`, `{#key}`, `{#snippet}`,
  `<svelte:boundary>`. `css` is `null` when the block has no root `<style>`.
- `<svelte:component>` and `<svelte:self>` warn as deprecated in runes mode, so their fixtures are legacy components.
  `<svelte:fragment slot>` must sit directly in a `Component` (not `<svelte:self>`).
- `$x` as an attribute name is a compile error on an element, a valid prop on a component (`<Child {$style} />` passes
  prop `$style`). A shorthand `{$style}` (attribute or object property) must keep its name: renaming only the
  identifier would rename the prop / key.
- Rendering: the server JS written to a temp file under the repo (`packages/e2e/.tmp`, so `svelte` resolves) and
  loaded with `import()`, then `render(Component, {props})` from `svelte/server`, gives the stamped HTML; a child passed
  as a prop with `{...rest}` on its root carries the stamp from the component element.
- Every existing `<svelte>` fixture (`Card`, `Button`, `ReactDefaultSpecifier`, `editor/GrammarEdges`,
  `react/AllBlocks`, and the valid `svelte/errors/` ones) compiles after the rename.
- Without plugin-svelte, Vite now fails a svelte pick with `[PARSE_ERROR]` on `/abs/X.ucf.svelte.svelte`
  (`e2e/build/react-target.spec.ts:144-147` expects `target-not-built` today).

Related bug found (5.1 code, fixed here, own commit + test): `ctx.modules` is a plain object, so `$constructor`,
`$toString`, … read `Object.prototype` (`svelte.ts:70`) and count as a class map: no `missing-style-module`.

## Plan

### 1. Fix: own module names only (`svelte.ts:70`)

One lookup, `classMap(bare, ctx): StyleModule | undefined` with `Object.hasOwn`: `style` → `$style`, else `style`
(`module="style"`); any other name → `ctx.modules[bare]`. `WrongModuleName.ucf` gains a `{$constructor}` use → one
more `missing-style-module` row (line/column hand-written, snapshot updated).

### 2. Uses: `missingStyleModules` (`svelte.ts:58-80`) becomes `styleUses(root, block, ctx)`

Same walk and skips as 5.1; returns `{missing: Diagnostic[], uses: {node, module, shorthand?}[]}`.
`shorthand`: the identifier is a shorthand object property (`parent.type === 'Property' && parent.shorthand`) or a
shorthand attribute (an `Attribute` whose `ExpressionTag` identifier starts at `attribute.start + 1` with the same
name, recorded when the walk passes the attribute). `walk` (`:22-32`) gains "visit returns `false` → skip children".

### 3. `build(block, ctx)` returns `{ext: '.svelte', code, map}`

MagicString over `ctx.source`, `remove(0, contentStart)` and `remove(contentEnd, length)` as `react.build`
(`react.ts:99-120`), so the map points into the `.ucf` file (`generateMap({source: ctx.filename, hires: true,
includeContent: true})`).

1. Parse once (today's code); `missing` non-empty → throw as today.
2. **Locals**: per used module, `__ucf` + its Svelte name with the first letter upper-cased (`$style` →
   `__ucfStyle`, `$classes` → `__ucfClasses`); a name already bound in the block, or taken by another module
   (`classes` / `Classes`), gets a number suffix (React's `freshName`, moved from `react/scope.ts` to `ast.ts`).
3. **Renames**: each use → `overwrite(identifier, local)`; shorthand property → `$style: __ucfStyle`; shorthand
   attribute → overwrite the attribute with `$style={__ucfStyle}`. Runes, stores, property, import / export and type
   names are not uses (5.1's rule), so they stay.
4. **Imports**: `import "<styleId>";` per `ctx.styles` entry, then `import __ucfX from "<classMapId>";` per used
   module (JSON quoting, as React). They go into `<script module>` when the block has one, else into the instance
   `<script>`, at `content.start` (`appendLeft`, one `\n` before each line). No script at all → `prependRight` at
   `contentStart`: `<script>\n…\n</script>`. No import → scripts untouched.
5. **Stamps** (only `ctx.hasScoped`): walk `root.fragment`; on `RegularElement`, `SvelteElement`, `Component`,
   `SvelteComponent`, `SvelteSelf` → `appendLeft(contentStart + start + 1 + name.length, ' data-v-<scopeId>=""')`;
   `SvelteHead` → skip its subtree. Every other node (blocks, `SvelteBoundary`, `SvelteFragment`, `SlotElement`,
   `SvelteWindow` / `Body` / `Document`) is walked, never stamped. `<svelte:options>` is not in the fragment.
6. No `<style>` is emitted: a root one is already `style-inside-target`.

### 4. Fixtures: `packages/e2e/fixtures/components/svelte/shapes/`

Each has `<style module scoped>` (classes only through `$style`, so every rendered class is a module class), runes
unless noted.

- `Elements.ucf` (`lang="ts"`: nested, void, self-closing, `<svg>`; `$style` in script, in markup, as `{$style}`
  object shorthand), `SvelteElement.ucf`, `Components.ucf` (`<Child>`, with children, `<ui.Child>`,
  `<Child {$style} />`, a snippet prop), `SvelteComponent.ucf` (legacy), `Slots.ucf` (legacy: `<slot>` with fallback,
  named `<slot>`, `<svelte:self>` recursion, `<Child><svelte:fragment slot>`), `IfBlock.ucf`, `EachBlock.ucf`,
  `AwaitBlock.ucf`, `KeyBlock.ucf`, `Snippets.ucf`, `Boundary.ucf`, `SpecialElements.ucf` (`<svelte:options>`,
  `<svelte:head>` with title / meta / style, `<svelte:window>`, `<svelte:body>`, `<svelte:document>`).
- Text edges: `LessThan.ucf` (`{a < b}`), `AttributeGt.ucf` (`>` in quoted values), `CommentedTag.ucf`
  (`<!-- <div> -->`), `ScriptString.ucf` (`'<div>'` in script strings), `NoScript.ucf`, `ModuleScriptOnly.ucf`.
- `Child.svelte`: plain Svelte 5, `let {children, ...rest} = $props()`, one `<b {...rest}>` root. The test compiles it
  and passes it as the `Child` prop.

### 5. Tests that change

- `core/test/blocks/index.spec.ts:88-94` "throws target-not-built for svelte" → "builds the svelte row as a `.svelte`
  file": `buildTarget(…, 'svelte')` equals `getBlockKind('svelte').build(…)`, `ext: '.svelte'`.
- `e2e/build/react-target.spec.ts:144-147` → "a svelte pick without plugin-svelte fails on its
  `AllBlocks.ucf.svelte.svelte` id" (the build gets past core now; 5.3 replaces it with its own message).
- `svelte.spec.ts:80-83, 138-139`: valid fixtures build instead of throwing `target-not-built`.

### 6. Dependency

Root devDependency `htmlparser2` 10.1.0 (2026-01-21, already in the lockfile through cheerio): counts every
attribute as written, duplicates included (parse5 drops duplicates and moves a stray `<td>`).

## Decisions

- Imports go into `<script module>` when there is one, else the instance `<script>`, else an added `<script>`: only
  that placement makes `$style` work inside `<script module>` too (orchestrator, rule 3).
- Only the class maps the block uses are imported: no clash, no dead import when `<style module>` and
  `<style module="style">` both exist (orchestrator, rule 3).
- The react-target svelte-pick test stays, now checking the build fails on the `AllBlocks.ucf.svelte.svelte` id until
  5.3 adds its own message (orchestrator, rules 1 and 4).
- `htmlparser2` 10.1.0 is a root devDependency (orchestrator, rule 1).

## Tests

All in `pnpm devx test`, this host and CI `check` job; they need only root devDependencies (`svelte`, `oxc-parser`,
`@jridgewell/trace-mapping`, `htmlparser2`).

`packages/core/test/blocks/svelte.spec.ts`:

- 5.1 table: valid rows build; `WrongModuleName.ucf` gains its `$constructor` row.
- "has a row for every fixture" for `svelte/shapes/`.
- Per shape (`describe.each`), `ctx` from `createBuildContext` (root `FIXTURES_DIR`):
  - `build` → `ext: '.svelte'`; real `compile` with `generate: 'server'` and `'client'`: no throw, `warnings` empty,
    `css` null;
  - code snapshot `__snapshots__/svelte/shapes/<Name>.ucf.svelte.snap` (`FIXTURES_DIR` → `<fixtures>`);
  - only inserts: stamps, our import lines and the added `<script>` removed and renames undone → block content;
  - re-parsed output: every stampable node carries `data-v-<id>` exactly once, and nothing in `<svelte:head>`, nor
    `<svelte:window|body|document|fragment>`, `<slot>`, `<svelte:boundary>` does; same node names in the same order
    as the input;
  - imports: in `<script module>` when there is one, else the instance script, else an added one; class map ids
    = `classMapId()` of the used modules;
  - render: server JS to a temp file under `TMP_DIR`, class map imports pointed at sibling files holding
    `export default <ctx classes>` (what the Vite plugin serves), CSS imports dropped, `render` from `svelte/server`
    with `{Child}` where the fixture takes it. With htmlparser2: every body element has the stamp exactly once; the
    head has none; every class token is a generated module class (and at least one); no `svelte-` class. HTML
    snapshot `<Name>.ucf.html`;
  - map: right after each stamp traces to the end of the element name in the `.ucf` file; each `__ucfX` traces to its
    `$x` (line and column), or to the `{` of a shorthand attribute, which is overwritten whole.
- `NamedModule.ucf`: `$classes` and `$style` renamed (counted); `$count`, `$shared`, `$user`, `$first`, `$second`, `$others`,
  `$extra`, `$makeStore`, `$Store`, runes, `options.$theme`, `{$theme: …}`, `$Row`, `$Props`, `$fetch`, `$exported`
  unchanged. `ModuleNamedStyle.ucf`: `__ucfStyle` imports the `module="style"` class map.
- Sweep: every other fixture with a `<svelte>` block builds and compiles without throwing.
- `Components.ucf` holds `const ui = $derived({Child})`: a plain `const` of a prop is Svelte's
  `state_referenced_locally` warning.

## Docs

- `docs/milestones/m5-svelte-target.md` 5.2: text to what shipped (imports in the module script when present, one
  import per used module, shorthand forms, fixture names, `htmlparser2`), `- Status: done`.
- `docs/spec.md` 3.6: `$style` / `$name` become `__ucfStyle` / `__ucfName` (Svelte reserves `$`), where the imports go,
  which elements get stamped.
- `publicdocs/07-errors.md:38` and `publicdocs/04-imports.md:41`: drop "multifront does not build `<svelte>` blocks";
  `target-not-built` stays the editor's (no svelte types until 5.9).
- `docs/architecture.md`, `docs/plan.md`: no change (no structure change).

## Fuzzing

None in this step: 5.7 is the planned seeded fuzz over this exact build (recombined `shapes/`, compared with a plain
`.svelte` render).

## Out of scope

Serving the id in Vite and the "plugin-svelte missing" error (5.3), imports from and into Svelte (5.4), HMR (5.5),
SSR app (5.6), fuzz (5.7), root forwarding and its warning (5.8), types (5.9), legacy `$$restProps`.

## Done when

- `buildTarget(split, ctx, 'svelte')` returns a `.svelte` file that real `svelte/compiler` compiles with no warning
  for every `shapes/` fixture, and its render carries the scope once on every element from the block.
- The `$constructor` fix and its test are in their own commit.
- `pnpm devx check` passes; the milestone doc, spec 3.6 and the two public pages match what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
