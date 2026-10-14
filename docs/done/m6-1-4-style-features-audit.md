---
type: feature
spec: full-plan
status: done
created: 2026-10-14
milestone: 6.1
step: 6.1.4
---

# Style features audit across the three frameworks

## Problem

Spec 2 promises Vue's `<style>` semantics in every framework, but no one has checked every feature in React and Svelte
side by side, nor the JS side (props, refs, slots). A scratch app rendered each feature in Chromium (build and dev) for
Vue, React and Svelte:

- Same in all three: global, scoped and module styles, scss / sass / postcss, `@import` in a style, CSS variables
  (also a parent's custom properties through `style`, and Svelte's own `<Child --accent="…">`), `:deep()`,
  `:global()`, a parent's scoped style on a child root, a parent's scoped style on slot / children / snippet content
  (default, named, scoped with an argument), a child's scoped style NOT reaching that content.
- JS side, each framework's own way, all working: props; element refs on root and inner elements (React `useRef`, Vue
  template ref, Svelte `bind:this`); a parent's ref to a `.ucf` child (React: the root element through `__ucfRef`, Vue:
  the instance with `defineExpose`, Svelte `bind:this`: the instance with its exports); slots / children / snippets
  with arguments.
- **Gap 1, `v-bind()` in CSS**: Vue works. React and Svelte compile it to `var(--<id>-color)` that nothing sets: the
  property silently falls back (black text, no error).
- **Gap 2, `:slotted()`** in `<style scoped>`: Vue works (`data-v-<id>-s` on slot content). React and Svelte compile it
  to `.x[data-v-<id>-s]`, which nothing matches: silently ignored.
- **Untested anywhere**: `lang="less"` / `"stylus"`. Neither is installed. `invalid/MissingPreprocessor.ucf` (less)
  and `packages/core/test/styles.spec.ts:181` need less missing.

## Plan

### 1. New check `vue-only-style` (core, no compiler)

- `packages/core/src/types.ts:65-83`: add `'vue-only-style'` to `DiagnosticCode`.
- `packages/core/src/blocks/style.ts` `check()`: when the file has a `<react>` or `<svelte>` block
  (`split.targets`), one error per spot:
  - One regex, `/v-bind\s*\(|(?<!:):slotted\(|::v-slotted\(/g`, over the block content with
    `/\*[\s\S]*?\*\/|\/\/.*/` comments blanked to spaces so offsets hold (compiler-sfc `parseCssVars`'s comment
    rule). `v-bind(` in any style block; `:slotted(` / `::v-slotted(` only in `scoped` ones (Vue rewrites them only
    there). The shadow DOM `::slotted()` is left alone.
  - Known limit, accepted: a `:slotted(` Vue leaves as written (inside `:deep()` / `:global()`, or in a string) is
    flagged too; such selectors mean almost nothing.
  - Span = the matched text. Messages, one line, `orList` of the blocks the file has:
    `v-bind() in <style> works in <vue> only, not in <react> or <svelte>; set a CSS variable through the style prop instead`
    and `:slotted() in <style scoped> works in <vue> only, not in <react> or <svelte>; use :deep() or style the content from the parent`.
- React / Svelte builds: the style module load already runs `getBlockKind('style').check()`
  (`packages/vite/src/plugin.ts:199`), so those targets fail. `buildTarget` runs only the `<vue>` kind's check
  (`packages/core/src/blocks/index.ts:33`), so the Vue target of the same file still builds. Editor: shows it through
  `checkBlocks` (`packages/language-tools/src/multifrontService.ts:19`). A `<vue>`-only file (`vue/VBind.ucf`) gets
  nothing.

### 2. Stylus

- `stylus` as an exact-pinned root devDependency. Tested in the browser app's `Langs.ucf` and a new
  `components/langs/StylusPlain.ucf` (style-parity compares our CSS with plugin-vue's). less stays missing.

### 3. Audit table in `docs/spec.md`, new "3.8 Style features in every framework"

Rows × Vue / React / Svelte, each cell "works", "error (`vue-only-style`)" or "no, in all three": style blocks, each
`lang`, `@import`, CSS variables, `:deep()`, `:global()`, `:slotted()`, `v-bind()`, a parent's scoped style on a child
root, a parent's `class` / `style` on a child root, a parent's scoped style on slot content, a child's scoped style on
slot content, props / refs / slots (each framework's own way). One line: a browser test renders each group in all three.

## Decisions

Orchestrator's answers to the plan:

1. `v-bind()` / `:slotted()` in React and Svelte: the `vue-only-style` error ("not now" for spec 12; a silent fallback
   is the worst surprise; building it is out of scope).
2. less / stylus: add `stylus` (exact-pinned root devDependency), test it in `Langs.ucf` and `langs/StylusPlain.ucf`;
   less stays missing for the missing-preprocessor test; the table's less cell says why it is not rendered.
3. No fuzz: the rule is Vue's own regex, pinned by the compare-to-Vue assertion.
4. An error, not a warning: a mixed file must not ship a React or Svelte target that looks different from Vue's.
5. After review: the error counts as "fixed here" for `:slotted()` as for `v-bind()`; no todo for making `:slotted()`
   work in React / Svelte (spec 2 keeps it Vue-only in v1). The milestone's step text and Out of scope say so.

## Tests

All run on this host and in CI's `check` job (Chromium already there). No new infra.

1. Core, `packages/core/test/check.spec.ts`: new fixture `components/invalid/VueOnlyStyle.ucf` (vue + react + svelte;
   `<style scoped>` with `v-bind(color)`, `:slotted(.a)`, `::v-slotted(.b)`, `::slotted(.c)`, and `v-bind(` /
   `:slotted(` in a comment; plain `<style>` with `v-bind(size)` and `:slotted(.e)`; `<style scoped lang="scss">` with
   a `// v-bind(size)` line comment and `v-bind (size)`): exactly 5 errors at exact line / column; the v-binds' names
   equal compiler-sfc's `descriptor.cssVars` of its `<vue>` SFC code. `vue/VBind.ucf`: no
   error. Rows wherever invalid fixtures are listed.
2. Build, new `packages/e2e/build/vue-only-style.spec.ts`: a real Vite build per framework importing
   `invalid/VueOnlyStyle.ucf`: react and svelte fail with `(vue-only-style)` at one of its spots (the style module that loads first); vue builds, its CSS holds
   the `var(--…)` and `[data-v-…-s]` rules.
3. Editor: the `listComponents('invalid')` cases of `packages/e2e/editor/lib/cases.ts` take the new fixture.
4. Browser, new app `packages/e2e/fixtures/apps/style-features/` (`Parent.ucf` with three blocks; children per group:
   `Blocks.ucf`, `Langs.ucf`, `Vars.ucf`, `Frame.ucf`, `VueFeatures.ucf` (`<vue>` only, Vue parent only), `Api.ucf`),
   new `packages/e2e/browser/style-features.spec.ts`, build + preview and dev, one page per framework
   (`?framework=…`, so a page holds only that framework's CSS): per case (`blocks`, `langs`, `vars`,
   `fallback`, `frame`) every element's computed styles equal Vue's, element by element, plus hand-read anchors in all
   three; Svelte's `svelte-css-wrapper` case on its own; Vue
   `:slotted` / `v-bind` values; no console problem. Props, refs, slots: one `it` per framework on the rendered text.

## Docs

- `docs/spec.md`: section 2 (`v-bind()` and `:slotted()` Vue only, `vue-only-style` otherwise), 3.2 (the new
  `checkBlocks` rule), new 3.8 (the table), section 12 (`v-bind()` answered).
- `docs/plan.md` open question 2: answered.
- `publicdocs/03-styles.md` (`:deep()` / `:global()` in every framework, a "Vue-Only Features" section with the CSS
  variable in their place), `02-component-files.md` Block Rules, `07-errors.md` (a `vue-only-style` row).
- `docs/architecture.md`: none, no structure change.
- Milestone doc: `- Status: done`.

## Out of scope

`v-bind()` or `:slotted()` working in React / Svelte; making props, refs or slots look alike; SSR, HMR; `<style src>`;
Svelte's own `<style>` syntax.

## Done when

- The audit table is in `docs/spec.md`; every row is "works", "error" or "no, in all three", each pinned by a test.
- React and Svelte builds of a file using `v-bind()` / `:slotted()` fail with `vue-only-style` at the exact spot; its
  Vue target builds; the editor shows it.
- `pnpm devx check` green, `pnpm exec vitest run` in `packages/core` green.
- The simplify-comments pass ran on every touched source file, committed on its own.
