---
type: fix
spec: guidelines
status: ready
created: 2026-10-10
---

# `<style module scoped>` with `composes` never compiles in compileStyles

## Intent

A block with both `module` and `scoped` that uses `composes` (from a file or a local class) gets one
`style-compile-error` from `compileStyles()` (core, `src/styles.ts`):

```
<style> does not compile: composition is only allowed when selector is single :local class name not in ":local(.tag)[data-v-…]"
```

`compileStyleAsync({scoped: true, modules: true})` runs Vue's scoped plugin before postcss-modules, so the selector
already carries `[data-v-…]` when postcss-modules checks it. plugin-vue + Vite compile the same block fine: plugin-vue
scopes it, then Vite's CSS modules run on the result, and composed files come out scoped too
(`.base_<id>_0[data-v-<id>]`, seen with Vite 8.2 + plugin-vue). Our CSS must match theirs.

## Direction

- Reproduce on the current `@vue/compiler-sfc`; check whether the plugin order is configurable there first.
- Otherwise options to weigh: run CSS modules on the class selectors before the scoped rewrite, or compile a scoped
  module block in two passes the way plugin-vue + Vite do. The implementer plans the details.
- The composes loader in `src/styles.ts` already passes `scoped` to each composed file's compile; today that path is
  unreachable because the block fails first.
- Test: a `<style module scoped>` block with `composes … from` in a valid fixture, so the style-parity e2e test
  (`packages/e2e/build/style-parity.spec.ts`) compares it with plugin-vue + Vite, plus its CSS snapshot.

## Docs

`docs/milestones/m1-splitter-block-kinds-styles.md` (1.8, `compileStyles`) only if the compile steps change.

## Done when

- A scoped module block with `composes` compiles, and its CSS equals plugin-vue + Vite's in the style-parity test.
- The simplify-comments pass ran on every touched source file, committed on its own.
