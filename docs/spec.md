# Multi-target SFC compiler, Spec v0.1

Working name: **multifront**. This spec uses `uc` ("universal component") and the `.uc` extension as placeholders.

## 1. Goal

Write one component file that contains a full Vue, React (TSX) and/or Svelte implementation, plus **shared styles** compiled with Vue's style pipeline (scoped CSS, CSS modules, preprocessors). The main use case is a **multi-framework UI library** with zero runtime dependencies in the components, published as one package per framework.

### Non-goals (v1)

- Sharing component _logic_ across frameworks. Each target block is a complete, self-contained component in its own language.
- Forking or patching Vue. `@vue/compiler-sfc` is used only through its public exports.
- Consumers running this compiler. It runs at the library's build time only.

## 2. File format

```html
<vue>
  <script setup lang="ts">
  defineProps<{ title: string }>()
  </script>
  <template>
    <div :class="$style.card"><h2>{{ title }}</h2></div>
  </template>
</vue>

<react>
  export default function Card({ title }: { title: string }) {
    return <div className={$style.card}><h2>{title}</h2></div>
  }
</react>

<svelte>
  <script lang="ts">
    let { title }: { title: string } = $props()
  </script>
  <div class={$style.card}><h2>{title}</h2></div>
</svelte>

<style module lang="scss">
.card { padding: 1rem; }
</style>
```

Rules:

- **Root blocks:** `<vue>`, `<react>`, `<svelte>`, and any number of `<style>` blocks. Each target block may appear at most once. At least one target block is required.
- **Target block content** is a complete component in that language:
  - `<vue>`: the inner content of a normal `.vue` SFC (`<script>`, `<script setup>`, `<template>`). It must not contain its own `<style>` blocks; styles live at the root.
  - `<react>`: a TSX module. It **must** export default the component.
  - `<svelte>`: the content of a normal `.svelte` file, without `<style>`.
- **`<style>` attributes** follow Vue semantics: `scoped`, `module` / `module="name"`, `lang` (scss/less/stylus/postcss). `v-bind()` in CSS is supported for the Vue target only in v1.
- **`$style`** is available in every target block when a `<style module>` exists (named modules use their name). For React and Svelte it is auto-imported; an explicit import is not needed.

## 3. Architecture

```
.uc file
 └─ splitBlocks()               own code, raw-text root splitter + offsets
      ├─ styles ─ compileStyleAsync() (@vue/compiler-sfc)  → CSS + class map + scope id
      ├─ <vue>    → virtual Card.vue      → @vitejs/plugin-vue
      ├─ <react>  → scope transform (oxc/babel) → virtual Card.tsx → @vitejs/plugin-react
      └─ <svelte> → scope transform → virtual Card.svelte → @sveltejs/vite-plugin-svelte
```

### 3.1 Dependency on Vue's compiler

- `@vue/compiler-sfc` is a **peer dependency**. When `@vitejs/plugin-vue` is present, borrow its resolved compiler (same approach as mion's `devtools/src/vite/sfcTransform.ts`) so versions never split.
- Only call public exports (`compileStyleAsync`, `parse`, `MagicString`, `babelParse`, `walk`). No deep imports into `dist/`.
- CI tests against a pinned supported range of `@vue/compiler-sfc`.

### 3.2 Block splitter (`splitBlocks`)

- Own implementation. Do not use Vue's `parse()` for the root level, because TSX (`<>`, generics, `a < b`) can confuse an HTML tokenizer.
- Scan only for top-level opening tags `<vue>`, `<react>`, `<svelte>`, `<style ...>`. Take content as **raw text** up to the matching closing tag (browser `<script>` semantics: the first `</react>` closes it).
- Output per block: `{ type, attrs, content, start, end, contentStart, contentEnd }`, used for source maps.
- Errors with exact locations: duplicate target block, unknown root tag, unclosed block, missing target block, `<react>` without `export default`.

### 3.3 Style pipeline

- Each `<style>` is compiled once per file with `compileStyleAsync({ id, scoped, modules, preprocessLang, filename, source })`.
- **Scope id:** a hash of the file path relative to the package root plus content (same scheme as plugin-vue), emitted as `data-v-<hash>`. It must be deterministic across builds and machines for SSR hydration.
- The resulting CSS is served as a virtual module (`Card.uc?uc&type=style&index=0&lang.css`) so Vite handles CSS, HMR and extraction.
- The CSS-module class map is served as a virtual JS module and imported as `$style` by non-Vue targets.

### 3.4 Vue target

- Emit a virtual `.vue` file: the `<vue>` block content plus each root `<style>` block re-attached with its original attributes.
- Hand it to `@vitejs/plugin-vue`. Scoped CSS, `$style` and `v-bind()` then work natively. The Vue target does **not** use 3.3; plugin-vue compiles the styles itself, so the CSS is identical by construction.
- Source maps: offset-shift from the virtual file back to the `.uc` file.

### 3.5 React target

- Emit a virtual `Card.uc.tsx` module from the `<react>` block, with:
  - `import $style from '<style module virtual id>'` injected when a module style exists;
  - `import '<style virtual id>'` for each style block;
  - the scope transform below, applied when any style is scoped.
- **Scope transform** (oxc or Babel AST, MagicString edits):
  1. Every host JSX element (lowercase tag) gets `data-v-<id>=""`.
  2. Every component JSX element (capitalized / member expression) in this file also gets `data-v-<id>=""`, so the parent scope reaches the child root, matching Vue.
  3. In the default-exported component, every **returned root** JSX element gets `{...__ucScopeAttrs(props)}`, forwarding incoming `data-v-*` props. Handle multiple returns, conditional (`?:`, `&&`) roots, and unwrap `memo(...)` / `forwardRef(...)`. Fragment roots get no forwarding, plus a dev warning (Vue's multi-root rule).
  4. If the component destructures props in its parameter, rewrite to `(__props)` + `const {...} = __props` so the forward has access to all props.
- `__ucScopeAttrs` is a tiny helper inlined or imported from a runtime file under 20 lines with zero dependencies.
- Hand off to `@vitejs/plugin-react` for JSX/TS transform and Fast Refresh. The virtual id must end in `.tsx`.
- Third-party components don't forward scope attributes; document `className` + CSS modules as the way to style them.

### 3.6 Svelte target

- Emit a virtual `.svelte` file from the `<svelte>` block, inject the `$style` import into its `<script>`, and import the style virtual modules.
- Apply the same scope-attribute stamping to the markup (host elements and component elements) using `svelte/compiler`'s `parse` for locations.
- Do not emit a Svelte `<style>`. Svelte's own scoping is unused, so CSS behaves identically across targets.
- Root forwarding for Svelte is a stretch goal (`{...rest}` pass-through on the root element).

### 3.7 `$style` typing

- Generate a declaration per `.uc` file with the exact class names, for example `.uc/types/Card.uc.d.ts`, so `$style.card` autocompletes and typos fail in all three targets.
- `$style` is a global ambient per virtual module in v1; a proper per-block typing comes with editor support (milestone 6).

## 4. Vite plugin

- `uc({ targets: ['vue', 'react', 'svelte'], target?: 'react' })`
  - **Library build mode:** one Vite build per target. `import Card from './Card.uc'` resolves to that target's virtual module.
  - **App/dev mode:** explicit queries `./Card.uc?react`, `./Card.uc?vue`, `./Card.uc?svelte`. The bare import resolves to `target` if set, otherwise an error naming the options.
- Must run with `enforce: 'pre'` so plugin-vue / plugin-react / plugin-svelte see normal virtual files.
- **HMR:**
  - a style-only change hot-updates the style virtual module only;
  - a target-block change invalidates only that target's virtual module (Fast Refresh / Vue HMR / Svelte HMR do the rest).
- Uses its own `.uc` extension so plugin-vue, Volar and ESLint don't claim the file.

## 5. Library build output

One package per target from one source tree:

```
dist/react/   @lib/react   ESM, one file per component, .d.ts (tsc), CSS files
dist/vue/     @lib/vue     ESM, one file per component, .d.ts (vue-tsc), CSS files
dist/svelte/  @lib/svelte  uncompiled .svelte files (svelte-package convention) + processed CSS + .d.ts
```

Requirements:

- **CSS as real files**, never runtime injection (SSR + CSP safe). Each component JS imports its CSS; also emit a combined `styles.css` for consumers who prefer one import. `"sideEffects": ["*.css"]`.
- **React Server Components:** files whose component uses hooks or event handlers get `"use client"` at the top of the output file. The build must preserve the directive per output file (bundlers strip it in library mode).
- **React conventions:** root elements accept and merge `className` and `style`; refs forwarded. Theming through CSS variables, identical across targets.
- **Peer dependencies only:** react/react-dom, vue, or svelte. Zero runtime dependencies otherwise.
- `exports` map per package with types.

## 6. Milestones

1. **Splitter + styles** (1–2 days): `splitBlocks` with errors and offsets; style compile through `compileStyleAsync`; unit tests.
2. **React target** (4–7 days): virtual `.tsx`, `$style`, scope transform with root forwarding, Fast Refresh in a demo Vite app. _This is the go/no-go milestone._
3. **Vue target** (1–2 days): virtual `.vue` handed to plugin-vue; same demo renders both.
4. **Library build** (3–5 days): per-target builds, CSS files, `"use client"`, types. Verified in a fresh Next.js App Router app and a fresh Vite React app.
5. **Svelte target** (3–5 days).
6. **Editor support** (1.5–3 weeks): Volar language plugin mapping `<vue>` → embedded `.vue`, `<react>` → embedded `.tsx`, `<style>` → embedded `.css`/`.scss`; `$style` types; Prettier/ESLint for `.uc`.

## 7. Tests

- Splitter: fixture files covering TSX edge cases (`<>` fragments, generics, `a < b`, strings containing `</react>` in TSX → documented limitation), duplicate/unclosed blocks.
- Scope transform: snapshot tests per JSX shape (multiple returns, ternaries, `&&`, fragments, `memo`, `forwardRef`, destructured and non-destructured props).
- Visual parity: render the same component in all targets with Playwright and compare computed styles of key elements.
- SSR: render the React target with `react-dom/server` and hydrate without mismatch warnings.
- Library consumers: build the dist packages and install them into fixture Next.js and Vite apps in CI.

## 8. Open questions

- Final project name and file extension.
- Should a target block be allowed to `<style>` locally for target-only overrides?
- `v-bind()` in CSS for React/Svelte: drop, or implement via CSS variables on the forwarded root?
- Shared types between targets (props interfaces): a root `<types lang="ts">` block imported by every target?
- Should forwarding of scope attributes be opt-out per component?
