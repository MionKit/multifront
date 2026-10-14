---
type: feature
spec: guidelines
status: ready
created: 2026-10-14
---

# Same styling in every framework

## Intent

One `.ucf` component should look and be styled the same way from React, Vue and Svelte. Today a parent can pass a
class and a style to a React root (the compiler adds `className` / `style`) and to a Vue root (Vue does it by
itself), but a Svelte root accepts neither unless the author declares them by hand. So a library user gets different
styling hooks per framework, and the M6 consumer pages had to skip `class` / `style` on SvelteKit. Goal: everything
about CSS and styling works the same in all three. Plain JavaScript things (props, refs, slots) keep each
framework's own way, as long as they work.

## Direction

- **Svelte `class` and `style`.** Every forwarded Svelte root accepts and merges `class` and `style` the way React
  roots merge `className` and `style` (the parent's style keys win). Same "the author wins" rule as React: a
  component that handles the prop itself keeps it. Build on the existing Svelte root forwarding in
  `packages/core/src/blocks/svelte.ts` (it already adds `$props()` and the scope spread to each root) and the shared
  helper module in `packages/core/src/react/scopeHelper.ts`. Types follow: the Svelte virtual script and the library
  `.d.ts` gain `class?` and `style?`, as React's props type does through `reactRootProps()`.
- **Style feature audit.** List every style feature (`<style module>`, `<style scoped>`, preprocessors, CSS
  variables, `:deep()` / `:global()` / `:slotted()`, `v-bind()` in CSS, a parent's scoped style reaching a child
  root, styling of content passed into a component through its slot / children / snippet) and check each in all
  three frameworks. Close each gap here, or file a big one as its own todo. The spec's open question on `v-bind()` in
  CSS for React and Svelte is part of this audit.
- **JavaScript side: check only.** Passing props, element refs (React `ref`, Vue template ref, Svelte `bind:this`)
  and slots / children / snippets stay each framework's own method. Only confirm each works on a `.ucf` component;
  fix what is broken, add nothing to make them look alike.
- **Consumer apps.** The M6 consumer SvelteKit page (`packages/e2e/fixtures/apps/consumer-sveltekit/`) passes
  `class` and `style` to Button like the other three, and the exit test (`packages/e2e/consumer/exit.spec.ts`) drops
  its `target !== 'svelte'` skip, so all four apps check the same styling props.
- The implementer plans the details (helper names, edge cases, legacy-mode components, multi-root rules).

## Docs

- `docs/spec.md`: section 3 (Svelte transform gets the class / style merge of 3.5 item 5), section 8 "React
  conventions" becomes one styling rule for every framework, section 12 (answer the `v-bind()` open question).
- `docs/architecture.md`: the line on the helper module's "React root-prop merges" covers Svelte too.
- `publicdocs/03-styles.md`: its root-forwarding table and examples are React-first; it must say Svelte roots take
  `class` and `style`.

## Done when

- A parent can pass a class and a style to the same `.ucf` component from React, Vue and Svelte, in an app and
  through the library build, with editor and `.d.ts` types for each.
- The four M6 consumer apps pass the same styling props, and the exit test checks them in all four.
- Every style feature in the audit works in all three frameworks, or has its own todo.
- Props, refs and slots are confirmed working in each framework's own way.
- The simplify-comments pass ran on every touched source file, committed on its own.
