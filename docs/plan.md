# Implementation plan

How we build [the spec](spec.md).

## Packages

| Package | Job | When |
| --- | --- | --- |
| `@multifront/core` | Bundler agnostic: block splitter, style compile, scope ids, the target rules of spec 4.1, per-target transforms. Never imports Vite. | exists |
| `@multifront/vite` | The Vite plugin. Hands each target to plugin-vue, plugin-react or plugin-svelte, and rewrites import attributes. | exists |
| `@multifront/runtime` | Tiny zero-dependency helpers the compiled components import (`scopeAttrs`). | exists |
| `@multifront/language-core` | Volar language plugin: embedded code per block, per-target virtual scripts. | milestone 2 |
| `@multifront/typescript-plugin` | tsserver plugin: resolves `.uc` imports to the right target's types. | milestone 2 |
| `@multifront/language-server` | Volar language server for `.uc` files. | milestone 2 |
| `packages/vscode` | The VS Code extension (Marketplace and Open VSX, not npm). Bundled, the one package not built by plain `tsc`. | milestone 2 |
| `@multifront/build` | The library build, one package per target. | milestone 5 |
| `@multifront/tsc` | `mf-tsc`, the command line type check over every target. | milestone 7 |

## Prototype first

Three unknowns can change the design. Each gets a throwaway spike before its milestone starts:

1. **Types by import attribute.** A tsserver plugin whose `resolveModuleNameLiterals` reads `with { framework }` from the import and resolves `./Card.uc` to a per-target virtual script. If tsserver does not hand us the import node, fall back to the importer's framework and the default target only, and drop per-import overrides from the types (the build still honours them).
2. **A `<vue>` block in the editor.** Generate Vue virtual code from the block with `@vue/language-core` and map its offsets back into the `.uc` file.
3. **Attributes surviving each compiler.** Check plugin-vue's script compile, the Svelte compiler and Oxc all keep `with { ... }` on imports, so our post rewrite still sees it.

## Building on plugin-vue

We **compose** `@vitejs/plugin-vue`, never fork it. It is a peer dependency of `@multifront/vite`, and our plugin runs before it (`enforce: 'pre'`) so it only ever sees plain SFC code. What we learned reading plugin-vue 6.0.8:

1. **Borrow its compiler.** plugin-vue exposes `api.options.compiler`, filled in its `buildStart`. `getVueCompiler()` reads it, and falls back to resolving `vue/compiler-sfc` from the project root the same way plugin-vue does. Done and tested.
2. **The `vue` query is taken.** plugin-vue treats any id with a `vue` query as one of its own sub-requests (`Card.vue?vue&type=style`). Our internal ids use `?target=react` / `?target=svelte` instead (spec 4.2). Users never write a query; they use import attributes.
3. **No virtual `.vue` path.** On a cache miss (a dev server restart, SSR) plugin-vue reads the SFC from disk with `fs.readFileSync`, which fails for a file that does not exist. So the Vue target keeps the real `Card.uc` path as the module id: we add `/\.uc$/` to plugin-vue's `include` (its `api.include` setter, from our `configResolved`) and turn the `.uc` source into SFC code in our pre `transform`. This is the pattern unplugin-vue-markdown uses with `.md` files. A test must cover the restart and SSR cache misses.
4. **One scope id for all targets.** plugin-vue hashes `sha256(relativePath + (production ? source : ''))`, first 8 hex chars. It also takes `features.componentIdGenerator`, so we set our own generator there and use the same one for React and Svelte. Same `data-v-*` everywhere, by construction.

## Milestones

### 1. Splitter + styles

- `splitBlocks(source, filename)` in core: a hand-written scanner for top-level `<vue>`, `<react>`, `<svelte>`, `<style ...>`. Content is raw text up to the first matching closing tag.
- Errors carry `{code, message, line, column}`: `duplicate-target`, `unknown-root-tag`, `unclosed-block`, `missing-target`, `react-no-default-export`, `style-inside-target`.
- `compileStyles(blocks, {id, filename})`: `compileStyleAsync` once per `<style>`, returns CSS, map and the CSS-module class map.
- `scopeId(relativePath, source, production)`: the plugin-vue scheme above.
- Tests: splitter fixtures (`<>`, `<T,>`, `a < b`, `</react>` inside a string, duplicates, unclosed) and style snapshots (scoped, module, named module, scss).

### 2. Editor basics

- `packages/vscode`: `.uc` language id, file icon, TextMate grammar embedding the Vue, TSX, Svelte and CSS / SCSS grammars. Highlighting in every block from day one.
- `language-core`: the Volar language plugin. Embedded code for `<react>` (TSX) and `<style>` (CSS / SCSS), plus the `Card.uc.react.tsx` virtual script with `$style` typed from the class names.
- `typescript-plugin`: `.ts` / `.tsx` files importing `.uc` get the React types, using `resolveTarget()` from core (spike 1).
- `language-server`: completions, errors, hover and go to definition inside `<react>` and `<style>`.
- Tests: language-core snapshots of the virtual code and its offset mapping; a tsserver test that a `.tsx` importer sees the right props.

### 3. React target and imports (go / no-go)

- `resolveTarget(importer, attribute, options)` in core: the spec 4.1 rules, shared by the Vite plugin and the TypeScript plugin.
- Vite: resolve `.uc` imports to the per-target ids of spec 4.2; a post plugin moves `with { framework }` into the id and removes it (static, re-export and dynamic imports; a non-literal value is an error).
- Virtual modules: style CSS, class map, and `Card.uc?target=react&lang.tsx`.
- Scope transform in core (oxc-parser + MagicString): stamp host and component elements, forward on returned roots (several returns, `?:`, `&&`, `memo`, `forwardRef`), rewrite destructured props, warn on fragment roots.
- Tests: snapshot per JSX shape; every import rule and its order; no attribute left in dev, build or SSR output.
- Exit check: demo app renders the React Card; Fast Refresh keeps state; a style edit only reloads CSS; a parent scoped style reaches a child root.
- If the scope transform is not reliable, fall back to CSS modules only for React and revisit.

### 4. Vue target

- The composition described above: real `.uc` id, plugin-vue `include`, shared `componentIdGenerator`.
- Editor: the `<vue>` block through `@vue/language-core` (spike 2), and `Card.uc.vue.ts` for `.vue` importers.
- Tests: dev, build, SSR, a cache miss after restart, and one app importing the same file as React and Vue.

### 5. Library build

- `@multifront/build`: one Vite library build per target with `target` set, one JS file per component, real CSS files plus a combined `styles.css`.
- `"use client"` re-added per output file when the component uses hooks or event handlers.
- Types: `.d.ts` per target from the per-target virtual scripts. Writes each target's `package.json` with exports, types and peer deps only.
- Exit check: the packed React build works in a fresh Next.js App Router app and a fresh Vite React app.

### 6. Svelte target

- `Card.uc?target=svelte&lang.svelte` with the `$style` import, stamping via `svelte/compiler` `parse`, no Svelte `<style>`.
- Editor: `Card.uc.svelte.ts` through `svelte2tsx`, for `.svelte` importers and the `<svelte>` block's types.
- Library output: uncompiled `.svelte` files + processed CSS + `.d.ts`.

### 7. Full editor support

`mf-tsc` over every target, Svelte markup completions, Prettier and ESLint for `.uc`.

## Alongside every milestone

- HMR: style-only edits update only style modules; a target edit invalidates only that target.
- Visual parity test (Playwright) and SSR hydration test, once two targets exist.
- CI matrix over the supported `@vue/compiler-sfc` range.

## Open questions

1. Final file extension (`.uc` is a placeholder).
2. The attribute key: `framework` or `target`?
3. Target-only `<style>` inside a target block?
4. `v-bind()` in CSS for React / Svelte: drop, or CSS variables on the forwarded root?
5. Shared prop types: a root `<types lang="ts">` block?
6. Opt-out of scope attribute forwarding per component?
