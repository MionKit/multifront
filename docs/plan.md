# Implementation plan

How we build [the spec](spec.md). Package names below are the real ones in `packages/`.

## Packages

| Package | Job |
| --- | --- |
| `@multifront/core` | Bundler agnostic: block splitter, style compile, scope ids, per-target transforms. Never imports Vite. |
| `@multifront/vite` | The Vite plugin. Hands each target to plugin-vue, plugin-react or plugin-svelte. |
| `@multifront/runtime` | Tiny zero-dependency helpers the compiled components import (`scopeAttrs`). |
| `@multifront/build` | Later (milestone 4): the library build, one package per target. |

## Building on plugin-vue

We **compose** `@vitejs/plugin-vue`, never fork it. It is a peer dependency of `@multifront/vite`, and our plugin runs before it (`enforce: 'pre'`) so it only ever sees plain SFC code. What we learned reading plugin-vue 6.0.8:

1. **Borrow its compiler.** plugin-vue exposes `api.options.compiler`, filled in its `buildStart`. `getVueCompiler()` reads it, and falls back to resolving `vue/compiler-sfc` from the project root the same way plugin-vue does. Done and tested.
2. **The `?vue` query is taken.** plugin-vue treats any id with a `vue` query as one of its own sub-requests (`Card.vue?vue&type=style`). So the spec's `./Card.uc?vue` would break. Use `./Card.uc?target=vue` (and `?target=react`, `?target=svelte`) instead.
3. **No virtual `.vue` path.** On a cache miss (a dev server restart, SSR) plugin-vue reads the SFC from disk with `fs.readFileSync`, which fails for a file that does not exist. So the Vue target keeps the real `Card.uc` path as the module id: we add `/\.uc$/` to plugin-vue's `include` (its `api.include` setter, from our `configResolved`) and turn the `.uc` source into SFC code in our pre `transform`. This is the pattern unplugin-vue-markdown uses with `.md` files. A test must cover the restart and SSR cache misses.
4. **One scope id for all targets.** plugin-vue hashes `sha256(relativePath + (production ? source : ''))`, first 8 hex chars. It also takes `features.componentIdGenerator`, so we set our own generator there and use the same one for React and Svelte. Same `data-v-*` everywhere, by construction.

## Milestones

### 1. Splitter + styles

- `splitBlocks(source, filename)` in core: a hand-written scanner for top-level `<vue>`, `<react>`, `<svelte>`, `<style ...>`. Content is raw text up to the first matching closing tag.
- Errors carry `{code, message, line, column}`: `duplicate-target`, `unknown-root-tag`, `unclosed-block`, `missing-target`, `react-no-default-export`, `style-inside-target`.
- `compileStyles(blocks, {id, filename})`: `compileStyleAsync` once per `<style>`, returns CSS, map and the CSS-module class map.
- `scopeId(relativePath, source, production)`: the plugin-vue scheme above.
- Tests: splitter fixtures (`<>`, `<T,>`, `a < b`, `</react>` inside a string, duplicates, unclosed) and style snapshots (scoped, module, named module, scss).

### 2. React target (go / no-go)

- Virtual modules: `Card.uc?uc&type=style&index=N&lang.css` (CSS), `Card.uc?uc&type=module&index=N` (class map), `Card.uc?target=react` resolving to `Card.uc.tsx`.
- Scope transform in core (oxc-parser + MagicString): stamp host and component elements, forward on returned roots (several returns, `?:`, `&&`, `memo`, `forwardRef`), rewrite destructured props, warn on fragment roots.
- Snapshot test per JSX shape.
- Exit check: demo app renders the React Card; Fast Refresh keeps state; a style edit only reloads CSS; a parent scoped style reaches a child root.
- If the scope transform is not reliable, fall back to CSS modules only for React and revisit.

### 3. Vue target

- The composition described above: real `.uc` id, plugin-vue `include`, shared `componentIdGenerator`.
- Tests: dev, build, SSR, and a cache miss after restart.

### 4. Library build

- `@multifront/build`: one Vite library build per target, one JS file per component, real CSS files plus a combined `styles.css`.
- `"use client"` re-added per output file when the component uses hooks or event handlers.
- Types: `tsc` for React, `vue-tsc` for Vue. Writes each target's `package.json` with exports, types and peer deps only.
- Exit check: the packed React build works in a fresh Next.js App Router app and a fresh Vite React app.

### 5. Svelte target

- Virtual `.svelte` with the `$style` import, stamping via `svelte/compiler` `parse`, no Svelte `<style>`.
- Library output: uncompiled `.svelte` files + processed CSS + `.d.ts`.

### 6. Editor support

Volar language plugin, per-block `$style` types, Prettier and ESLint support for `.uc`.

## Alongside milestones 2 to 5

- `$style` types: a `.d.ts` per `.uc` file with the exact class names.
- HMR: style-only edits update only style modules; a target edit invalidates only that target.
- Visual parity test (Playwright) and SSR hydration test.
- CI matrix over the supported `@vue/compiler-sfc` range.

## Open questions

1. Final file extension (`.uc` is a placeholder).
2. Target-only `<style>` inside a target block?
3. `v-bind()` in CSS for React / Svelte: drop, or CSS variables on the forwarded root?
4. Shared prop types: a root `<types lang="ts">` block?
5. Opt-out of scope attribute forwarding per component?
