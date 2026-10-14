# Multi-target SFC compiler, Spec v0.1

Project name: **multifront**. Component files use the `.ucf` extension ("universal component file").

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
- **`<style>` attributes** follow Vue semantics: `scoped`, `module` / `module="name"`, `lang` (scss/less/stylus/postcss). `v-bind()` in CSS and `:slotted()` in a scoped style work for the Vue target only in v1: a file with a `<react>` or `<svelte>` block that uses them is an error (`vue-only-style`), since those targets would render without them. Every feature by framework: 3.8.
- **`$style`** is available in every target block when a `<style module>` exists (named modules use their name). For React and Svelte it is auto-imported; an explicit import is not needed.

## 3. Architecture

The full picture, with graphics: [architecture.md](architecture.md).

```
.ucf file
 └─ splitBlocks()               own code, raw-text root splitter + offsets
      ├─ styles ─ compileStyleAsync() (@vue/compiler-sfc)  → CSS + class map + scope id
      ├─ <vue>    → Card.ucf as SFC code   → @vitejs/plugin-vue
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
- Output per block: `{ type, attrs, content, start, end, contentStart, contentEnd, index }`, used for source maps; `index` is the block's position among blocks of its type.
- Errors with exact locations (offsets, line and column): duplicate target block, unknown root tag, unclosed block, missing target block, text outside a block. The splitter keeps going after an error, so every readable block still comes back.
- `checkBlocks(split)` adds the block rules of section 2, each block checked by its kind, with the same locations: `<react>` without a default export, a `<react>` block that does not parse, a `framework` attribute on an import inside `<react>`, a `<style>` at the top level of `<vue>` or `<svelte>`, an unknown style `lang`, two `<style>` blocks injecting the same module name, a `v-bind()` or a scoped `:slotted()` in a file with a `<react>` or `<svelte>` block (found as compiler-sfc finds them: comments skipped, `::slotted()` left alone). The React and Svelte style modules report this last one, so the Vue target of the same file still builds. It returns the splitter errors too, in source order: the one call hosts make.

### 3.3 Style pipeline

- Each `<style>` is compiled once per file with `compileStyleAsync({ id, scoped, modules, preprocessLang, filename, source })`.
- An input map over the `.ucf` source goes with it, so the CSS source map points into the `.ucf` file, not the block.
- CSS module class names are `<local>_<scopeId>_<index>` (`card_1a2b3c4d_0`): the same on every machine.
- **Scope id:** a hash of the file path relative to the Vite root plus content (same scheme as plugin-vue), emitted as `data-v-<hash>`. It must be deterministic across builds and machines for SSR hydration.
- The resulting CSS is served as a virtual module (`Card.ucf?ucf&type=style&index=0&lang.css`) so Vite handles CSS, HMR and extraction.
- The CSS-module class map is served as a virtual JS module (`Card.ucf?ucf&type=style&index=0&module&lang.js`) and imported as `$style` by non-Vue targets.

### 3.4 Vue target

- The Vue target keeps the real `Card.ucf` path as its module id. The plugin adds `.ucf` to plugin-vue's `include` and, in a pre `transform`, turns the `.ucf` source into SFC code: the `<vue>` block content plus each root `<style>` block re-attached with its original attributes.
- No virtual `.vue` path: on a cache miss (dev server restart, SSR) plugin-vue re-reads the file from disk, which fails for a file that does not exist.
- plugin-vue then compiles it. Scoped CSS, `$style` and `v-bind()` work natively. The Vue target does **not** use 3.3; plugin-vue compiles the styles itself, so the CSS is identical by construction.
- plugin-vue's `features.componentIdGenerator` is set to the scope id of 3.3, so `data-v-*` matches the other targets.
- Vite's `css.modules.generateScopedName` names the `.ucf` module classes `<local>_<scopeId>_<index>`, so `$style` class names match the other targets too. Other files keep their own names.
- Source maps: the SFC code keeps the `.ucf` file's exact length and line breaks (every other target block is blanked to spaces), so each position is the same and the map is a shift of zero. Every map's source text is the `.ucf` file itself.

### 3.5 React target

- Emit a virtual `Card.ucf.react.tsx` module (the id of 4.3) from the `<react>` block, with:
  - `import $style from '<style module virtual id>'` injected when a module style exists;
  - `import '<style virtual id>'` for each style block;
  - those imports after a leading directive, so a `"use client"` stays first;
  - the scope transform below: stamping (steps 1 and 2) when any style is scoped, root forwarding (steps 3 and 4) always.
- **Scope transform** (oxc or Babel AST, MagicString edits):
  1. Every host JSX element (lowercase tag) gets `data-v-<id>=""`.
  2. Every component JSX element (capitalized / member expression) in this file also gets `data-v-<id>=""`, so the parent scope reaches the child root, matching Vue.
     Fragments (`<>`, React's `Fragment`) get nothing: React warns on extra Fragment props.
  3. In the default-exported component, every **returned root** JSX element gets `{...__ucfScopeAttrs(props)}`, forwarding incoming `data-v-*` props. Handle multiple returns, conditional (`?:`, `&&`) roots, and unwrap `memo(...)` / `forwardRef(...)`. Fragment roots get no forwarding, plus a dev warning (Vue's multi-root rule).
     - Roots: every `return` of the component (not of nested functions) and an arrow's expression body, through parentheses, `as` / `satisfies` / `!`, both `?:` branches, the right side of `&&` / `||` / `??`, and one hop to a top-level `const x = <jsx>` of the component. `null`, strings, calls and `children` get nothing.
     - `props` is the first parameter (a TypeScript `this` parameter is skipped). With none, the build adds `__props` (`(__props, __ref)` inside `forwardRef`, which React checks for zero or two parameters). A body that declares that name again gets no forwarding.
     - The warning is dev only, once per component, named by the file's base name (`<FragmentRoot>`), and only when a parent passed a `data-v-*` prop.
     - It fires only when the fragment is the rendered root. A fragment held in a `const` warns at the `return` that names it, and only when it is the const's whole value (a mixed `c ? <>...</> : 'text'` gets none).
  4. If the component destructures props in its parameter, rewrite to `(__props)` + `const {...} = __props` so the forward has access to all props.
     - The pattern text moves as written (defaults, rest, comments) into `const <pattern> = __props;` right after the body's `{` (after its directives, such as `'use no memo'`, which must stay first). An expression-bodied arrow gets `{const <pattern> = __props; return <body>}`. The type annotation and a parameter default stay on `__props`.
     - `__props` (and `__ref`, added in `forwardRef`) takes the first of `__props`, `__props1`, `__props2`, ... that no identifier of the block uses.
     - No forwarding when the body declares a name the pattern binds or reads (its defaults and computed keys; moved into the body, they would meet), when a later parameter reads a name it binds, nor for a rest first parameter (`(...args)`).
  5. **Root props.** On the same roots (fragments get nothing), the component accepts and merges `className` and `style` and forwards `ref` (React 19, where `ref` is a prop):
     - An own `className="a"` or `className={a}` becomes `className={__ucfClass(a, props.className)}`; `style` the same with `__ucfStyle` (the parent's keys win); an own `ref={r}` becomes `ref={__ucfRef(r, props.ref)}`, a ref that sets both. With no own one, `className={props.className}` (and `style`, `ref`) is added right after the forwarding spread, before every author attribute, so a later author spread that carries it still wins. Of several own ones, the last is merged. An own one with no value, or a string `style` / `ref` (braced or not), is left as written.
     - A `className` string with a line break or `\` is merged as the JS string the JSX transform makes of it (`"a\nb"`). One with an `&` is left unmerged: JSX decodes entities, which the build does not.
     - The author wins: a prop the component handles itself is left alone. It does when the destructured first parameter has that key (`{className}`, `{className: extra}`), when it reads `props.className`, `props?.className` or `props['className']` anywhere, also through `props!` or `props as Props`, when it destructures `props` with that key anywhere (`const {ref} = props`, a computed `['ref']` key too), but never below an inner binding of the same name (`items.map((props) => …)`), and for `ref` in a `forwardRef` component (React passes it as the second parameter). A root that spreads `props`, or the rest of such a pattern (`{...rest}`), gets none of the three.
     - Not detected: `props` passed on whole (`useThing(props)`, `<Inner {...props} />` below the root); the root still gets the props. Destructuring the prop opts out. No lint rule: the rule is syntactic and stated here.
     - The types say the same: in `Card.ucf.react.tsx` (section 5), so in the editor and in the library's `.d.ts`, the default export's props type gains `className?: string`, `style?: CSSProperties` and `ref?: Ref<…>`, each only when some root takes it. The ref type is the union of `ComponentRef<'button'>` for each host root and `Element` for a component root. It is written where the props type is: the first parameter's annotation, a `memo` / `forwardRef` type argument (`forwardRef<El>` gains one), or a parameter of its own when there is none. A parameter with no annotation keeps its own type. Core's `reactRootProps()` gives the roots and those places, from the same analysis the build runs.
- `__ucfScopeAttrs` and the root-prop merges `__ucfClass`, `__ucfStyle` and `__ucfRef` are helpers of a few lines, served by the Vite plugin as one virtual module, so they are bundled once and shipped components get no runtime dependency. The Svelte target (3.6) calls `__ucfStyle` too, and its own `__ucfSvelteClass`. With no incoming prop, a merge gives back the root's own value. Two class strings are joined with a space; `__ucfSvelteClass` gives `[own, extra]` for any other class value, which Svelte flattens. `__ucfStyle` spreads two objects (React) and joins anything else with `; ` (Svelte's text, the parent's declarations last, so its keys win). A helper whose name the block already uses is imported under the first free one (`__ucfClass as __ucfClass1`), in the React and the Svelte target alike.
- Hand off to `@vitejs/plugin-react` for JSX/TS transform and Fast Refresh. The virtual id must end in `.tsx`.
- Third-party components don't forward scope attributes; document `className` + CSS modules as the way to style them.

### 3.5.1 Scope forwarding is the same in every framework

A parent's scoped style reaches the root of any child `.ucf` component, in every framework, as it does in Vue. So root forwarding always runs, on every component, whether or not the child has a style of its own:

```tsx
// Badge.ucf <react>, no <style> of its own
export default function Badge({label}) { return <span className="badge">{label}</span> }
// compiles to
export default function Badge(__props) {
  const {label} = __props
  return <span {...__ucfScopeAttrs(__props)} className="badge">{label}</span>
}
```

Svelte does the same through its props rest (3.6). It is pinned by browser tests in every framework and by fuzz tests over generated components.

### 3.6 Svelte target

- Emit a virtual `.svelte` file from the `<svelte>` block, inject the `$style` import into its `<script>`, and import the style virtual modules. Svelte reserves `$` for stores, so `$style` / `$name` become `__ucfStyle` / `__ucfName`, imported in `<script module>` when the block has one (so every script and the markup see it), else in the instance `<script>`, added when missing.
- Parse the block with the project's own `svelte/compiler` first and report, at `.ucf` positions, Svelte's parse error (`svelte-parse-error`) and a `$style` or `$name` with no matching `<style module>` (`missing-style-module`; a `$name` whose `name` is a declared store is Svelte's).
- Apply the same scope-attribute stamping to the markup (host elements and component elements, `<svelte:element>`, `<svelte:component>`, `<svelte:self>`, inside every block and `<svelte:boundary>`; never what `<svelte:head>` holds) using `svelte/compiler`'s `parse` for locations.
- Do not emit a Svelte `<style>`. Svelte's own scoping is unused, so CSS behaves identically across targets.
- Root forwarding (3.5.1) through the props rest: `let { title, ...__ucfRest } = $props()` and `{...__ucfScopeAttrs(__ucfRest)}` on the root, right after its stamp. Required, not a stretch goal.
  - A runes-mode component (Svelte's rule, read from the block) forwards when every branch of `{#if}`, `{#key}`, `{#await}` and `<svelte:boundary>` has at most one root: every element and component root gets the spread. An existing rest or `let props = $props()` is reused; with no `$props()`, one is added. Text, `{@render}`, `{@html}` and `<slot>` roots get nothing.
  - Several roots, an `{#each}` root or a legacy-mode component (`export let`, `$:`, `$$props`): no forwarding, and a dev warning like a React fragment root, with its own fix for legacy mode ("Use $props() to make it a runes-mode component."). A block with no rune and no legacy syntax gets nothing: the compiler option decides its mode.
- **Root props.** The roots that get the forwarding spread also accept and merge the parent's `class` and `style`, as React roots do `className` and `style` (3.5, item 5). Other shapes get neither, as they get no forwarding.
  - A root prop the root lacks rides the spread, passed on only when given: `{...__ucfScopeAttrs(__ucfRest, 'class', 'style')}` (beside a spread, Svelte renders `class={undefined}` as `class=""`). A later author spread that carries it still wins.
  - An own one is merged: `class={a}` becomes `class={__ucfSvelteClass(a, __ucfRest.class)}`, a text value or one of text and tags the template Svelte makes of it, entities decoded (`` class={__ucfSvelteClass(`a ${(b) ?? ''}`, __ucfRest.class)} ``), the `{style}` shorthand `style={__ucfStyle(style, __ucfRest.style)}`. One with no value is left as written. `class:` and `style:` directives stay: Svelte applies them on top, so a root's `style:color` beats the parent's `color`.
  - The author wins: a prop is left alone when the `$props()` pattern has its key (`class: klass`), or when the props object (the `$props()` name or the pattern's rest) is read with it anywhere in the instance script or the markup (`props.class`, `props?.['style']`, `props!.class`, `const {style} = props` or `= $derived(props)`). Unlike React's rule, a read below an inner binding of the same name counts too. A root that spreads the props object or the rest gets neither.
  - Types: in a library build and in the editor's script (section 5), the `$props()` annotation `T` becomes `(T) & {class?: import('svelte/elements').ClassValue | null; style?: string | null}`, each member only when some root takes it; a JS block's JSDoc `@type {T}` the same. The `$props()` line the build adds is typed that way. An unannotated `$props()` keeps svelte2tsx's own type, which the added rest opens to any prop. An app build writes no types: Svelte strips them. `ClassValue` and Svelte's flattening of class values need Svelte 5.16, the library package's peer floor.

### 3.7 `$style` typing

- Generate a declaration per `.ucf` file with the exact class names, for example `.ucf/types/Card.ucf.d.ts`, so `$style.card` autocompletes and typos fail in all three targets.
- `$style` is typed per block by the per-target virtual scripts of section 5.

### 3.8 Style features in every framework

Each feature, checked in a browser in all three frameworks, from an app and a dev server:

| Feature | Vue | React | Svelte |
| --- | --- | --- | --- |
| Global `<style>`, `<style scoped>`, `<style module>`, named and scoped modules | works | works | works (`$name`) |
| `lang`: scss, sass, stylus, postcss | works | works | works |
| `lang`: less | same path as the others; not rendered here, the repo keeps less uninstalled to test the missing-preprocessor error | same | same |
| `@import` in a style | works | works | works |
| CSS variables: `var()`, a parent's custom properties through `style` | works | works | works, and Svelte's own `--name` props |
| `:deep()`, `:global()` | works | works | works |
| `:slotted()` in a scoped style | works | `vue-only-style` error | `vue-only-style` error |
| `v-bind()` in CSS | works | `vue-only-style` error | `vue-only-style` error |
| A parent's scoped style on a child's root | works | works (3.5.1) | works (3.6) |
| A parent's `class` / `style` on a child's root | works | works (`className`, 3.5 item 5) | works (3.6) |
| A parent's scoped style on content it passes in (slot, children, snippet) | works | works | works |
| The child's own scoped style on that content | no | no | no; `:deep()` reaches it in all three |

Props, element refs (`ref`, a template ref, `bind:this`) and slots / children / snippets keep each framework's own way; only the styling above is made the same.

## 4. Imports

How an import of a `.ucf` file picks the framework. This covers the library's own source, demo apps and tests. A published package has no `.ucf` files: consumers pick the framework by package name (`@lib/react`).

### 4.1 Inside a `.ucf` file: always automatic

An import inside a target block always gets that block's framework. Nothing to write:

```html
<react>
  import Icon from './Icon.ucf'   // the React Icon
</react>

<vue>
  <script setup lang="ts">
  import Icon from './Icon.ucf'   // the Vue Icon
  </script>
</vue>
```

- A `framework` attribute inside a block is a build error: a React component cannot render a Vue one.
- The imported file must have a block for that framework, or it is a build error naming both files.
- This holds in every build, whatever the global default is, so a library's components can import each other freely.
- Types follow the same rule inside the language plugin, with no TypeScript plugin involved: each block's virtual script imports the other file's virtual script for the same framework.

### 4.2 Outside a `.ucf` file: picking the target

For a plain `.ts`, `.tsx`, `.vue` or `.svelte` file, the most specific rule wins:

1. **Import attribute** on that import:

   ```ts
   import Card from './Card.ucf' with { framework: 'react' };
   export { default as VueCard } from './Card.ucf' with { framework: 'vue' };
   const SvelteCard = await import('./Card.ucf', { with: { framework: 'svelte' } });
   ```

   The key is `framework`, never `type` (hosts reserve `type` for `json` / `css`). The value must be a string literal; anything else is a build error.

2. **The importer's framework.** A `.vue` file gets vue, a `.svelte` file gets svelte, a `.jsx` / `.tsx` file gets react (configurable with the `importers` option).
3. **The global default**, the plugin's `framework` option. A library build runs once per framework with it set, so every bare import in that build follows.
4. **None of these** → a build error naming the three ways.

So in a one-framework app, a plain `import Card from './Card.ucf'` just works. The attribute is only for mixing frameworks in one app (a docs site showing all three, tests).

### 4.3 One module per file and target

- Each (file, target) pair is its own module. Its code is only that target's block, compiled. The other blocks never reach the framework plugin or the bundle.
- The file is split once and cached; every target reuses the split.
- React and Svelte share the style modules, which do not carry the framework. The Vue target uses plugin-vue's own style modules (3.4). So an app that imports one file as Vue and as another framework ships those rules twice. They are identical, so rendering does not change, and a library build has one framework per package, so it never happens there. Accepted for now; a later dedupe (answering plugin-vue's style request with the shared module) can remove it.
- Module ids (internal; users never write them):

| Target | Module id | Why |
| --- | --- | --- |
| vue | `/abs/Card.ucf` | plugin-vue needs a real file on disk (3.4) |
| react | `/abs/Card.ucf.react.tsx` | the path must end in `.tsx`: with plugin-react, Vite parses an id whose path is not JS, like `Card.ucf?…&lang.tsx`, without JSX |
| svelte | `/abs/Card.ucf.svelte.svelte` | plugin-svelte only picks up ids whose path, before any `?`, ends in `.svelte` |
| styles | `/abs/Card.ucf?ucf&type=style&index=N&lang.css` | shared by every target |
| style class maps | `/abs/Card.ucf?ucf&type=style&index=N&module&lang.js` | shared by React and Svelte; Vue uses plugin-vue's own (3.4) |

- Never a `vue` query: plugin-vue treats any id with one as its own sub-request (`Card.vue?vue&type=style`).
- The react and svelte ids name no file on disk, so Vite does not tie them to `Card.ucf`: `load` adds the `.ucf` file as a watch file, and our `hotUpdate` finds those modules by id when it changes.

### 4.4 Attributes never reach a runtime

Browsers and Node reject import attributes they do not know. A post `transform` on every importer moves the attribute into the module id and removes it. It runs before Vite's import analysis (dev) and before the bundler reads the imports (build), so we do not depend on whether Rolldown forwards attributes to `resolveId`. A non-literal attribute and an import the target rules reject are errors at that import, in the importer's own source.

## 5. Types

TypeScript gives one type per resolved file and never looks at import attributes. So `.ucf` types need our own tooling, the same way `vue-tsc` exists for Vue.

- **Per-target virtual scripts.** For `Card.ucf` the language plugin (section 6) exposes one TypeScript file per target: `Card.ucf.react.tsx` (the `<react>` block itself, with the root props of 3.5, item 5 in its props type), `Card.ucf.vue.ts` (from `@vue/language-core`) and `Card.ucf.svelte.ts` (from `svelte2tsx`, with the root props of 3.6 in its props type). Each exports that framework's component type: a React function component, a Vue `DefineComponent`, a Svelte `Component`.
- **Attribute-aware resolution.** A TypeScript plugin overrides module resolution (`resolveModuleNameLiterals`). It reads the import's `framework` attribute, or the importer's framework, or the default target, and resolves `./Card.ucf` to the matching virtual script. Same rules as 4.2, in one shared function in `@multifront/core`, so the editor and the build cannot disagree.
- **Where it runs:** in VS Code through the TypeScript plugin, on the command line through `mf-tsc` (a `tsc` wrapper like `vue-tsc`). Plain `tsc` sees no `.ucf` types.
- **`mf-tsc` checks every target** of every `.ucf` file, so a block that breaks only for one framework still fails.
- **Library output:** each target package gets real `.d.ts` files from its own virtual scripts. Consumers need none of this tooling.

## 6. Editor support (VS Code)

From the first milestones, not the last. Built on Volar, the framework behind Vue's language tools.

**Hybrid mode from day one**, as Vue's tools work today. VS Code's own tsserver, with our TypeScript plugin, does every TypeScript job, inside `.ucf` blocks too. Our language server does the rest: CSS, template HTML, our own diagnostics, formatting and linting. When it needs type information it asks tsserver through the client.

```json
"typescriptServerPlugins": [{
  "name": "multifront-typescript-plugin-pack",
  "enableForWorkspaceTypeScriptVersions": true,
  "languages": ["ucf"]
}]
```

tsserver finds a plugin only in an extension's own `node_modules`, so the extension ships a pack there that loads the bundled `@multifront/language-tools/typescript-plugin`. A project lists that subpath in its `compilerOptions.plugins` for its options.

So there is one TypeScript program: an unsaved edit in `Card.ucf` reaches `App.tsx` at once, and find references and rename work across `.ucf` and `.ts` files.

| Package | Job |
| --- | --- |
| `@multifront/language-tools` | The Volar language plugin (embedded code per block, the per-target virtual scripts and the resolution rules of 5); the TypeScript plugin (`./typescript-plugin`), which serves every TypeScript feature inside `.ucf` blocks and gives `.ts`, `.tsx`, `.vue` and `.svelte` importers the right types; the language server (`./server`) for CSS, template HTML and our own diagnostics; and the `mf-tsc`, `mf-lint` and `mf-fmt` commands. |
| `multifront-vscode` | The VS Code extension: `.ucf` language id, a TextMate grammar embedding the Vue, TSX, Svelte and CSS / SCSS grammars, starts the server, registers the TypeScript plugin. Published to the VS Code Marketplace and Open VSX, not npm. |

Order:

1. Grammar and file association: highlighting in every block.
2. TypeScript plugin and the `<react>` block. TSX is plain TypeScript, so full types land first.
3. `<style>` blocks: CSS / SCSS features.
4. `<vue>` block through `@vue/language-core`.
5. `<svelte>` block: types through `svelte2tsx`, markup completions later.
6. Formatting and linting for `.ucf` through oxfmt and oxlint.

### 6.1 Linting and formatting `.ucf` (last milestone)

The same tools as the rest of the repo: oxlint and oxfmt, reading the project's own `.oxlintrc.json` and `.oxfmtrc.json`. No new config.

- **Formatting:** oxfmt has a JS API, `format(fileName, source, options)`. We split the file, format each block as its own language and put the blocks back. Today oxfmt formats TSX, Vue SFC code and CSS / SCSS, but not Svelte, so `<svelte>` blocks stay as written until oxfmt supports them.
- **Linting:** oxlint already lints the script blocks of `.vue` and `.svelte` files, but it skips unknown extensions like `.ucf`. Two ways:
  1. Upstream: add `.ucf` to oxc's block extraction, next to the `.vue` / `.svelte` one. Best result, needs oxc maintainers to accept it.
  2. Ours: `mf-lint` writes each block as a temporary `.tsx` / `.vue` / `.svelte` file, runs oxlint with JSON output and maps the positions back to the `.ucf` file.
- **Editor:** the language server runs the same formatter and linter, so VS Code shows the same results as the command line.

## 7. Vite plugin

- `multifront({ frameworks?, framework?, importers? })`
  - `frameworks`: what this build may compile. Defaults to all three. An import that picks a framework outside the list is a build error.
  - `framework`: the global default of 4.2.
  - `importers`: importer extension to framework. Defaults to `{ '.vue': 'vue', '.svelte': 'svelte', '.jsx': 'react', '.tsx': 'react' }`.
  - **Library build mode:** one Vite build per framework, with `framework` set.
  - Users only ever see the word "framework": the import attribute, these options, the TypeScript plugin options and CLI flags. "Target" stays an internal word (the `Target` type, internal module ids), because `target` already means something else in the same config files (`build.target`, `compilerOptions.target`).
  - **App/dev mode:** imports follow 4.1 and 4.2.
- Must run with `enforce: 'pre'` so plugin-vue / plugin-react / plugin-svelte see normal component code. The attribute rewrite of 4.4 is a second, post plugin returned in the same array.
- **HMR:**
  - a style-only change hot-updates the style virtual module only;
  - a target-block change invalidates only that target's virtual module (Fast Refresh / Vue HMR / Svelte HMR do the rest).
- Uses its own `.ucf` extension so plugin-vue, Volar and linters don't claim the file.

## 8. Library build output

One package per target from one source tree:

```
dist/react/   @lib/react   ESM, one file per component, .d.ts (tsc), CSS files
dist/vue/     @lib/vue     ESM, one file per component, .d.ts (vue-tsc), CSS files
dist/svelte/  @lib/svelte  uncompiled .svelte files (svelte-package convention) + processed CSS + .d.ts
```

Requirements:

- **CSS as real files**, never runtime injection (SSR + CSP safe). Each component JS imports its CSS; also emit a combined `styles.css` for consumers who prefer one import. `"sideEffects": ["*.css"]`.
- **React Server Components:** files whose component uses hooks or event handlers get `"use client"` at the top of the output file. The build must preserve the directive per output file (bundlers strip it in library mode).
- **One styling rule for every framework:** a parent passes a class and a style to any component's root, the same in apps and in the library. Vue does it natively (attribute fallthrough); the compiler makes every React root accept and merge `className` and `style` and forward `ref` (React 19 and later, where `ref` is a prop), and every forwarded Svelte root accept and merge `class` and `style`. A component that handles one of these props itself keeps its own handling (3.5, item 5; 3.6). Theming through CSS variables, identical across targets.
- **Peer dependencies only:** react/react-dom, vue, or svelte. Zero runtime dependencies otherwise.
- `exports` map per package with types.
- **One command:** `mf-build` reads `multifront.config.ts` (`defineLibrary({...})`) and writes every package.

## 9. Milestones

1. **Splitter + styles**: `splitBlocks` with errors and offsets; style compile through `compileStyleAsync`; unit tests.
2. **Editor basics**: the VS Code extension with highlighting, and `language-tools` with the `<react>` virtual script and the TypeScript plugin resolving `.ucf` imports (steps 1 to 3 of section 6).
3. **React target and imports**: virtual `.tsx`, `$style`, scope transform with root forwarding, the target rules and attribute rewrite of section 4, Fast Refresh in a demo Vite app. _This is the go/no-go milestone._
4. **Vue target**: the real-path composition of 3.4 with plugin-vue, and the `<vue>` block in the editor; same demo renders both.
5. **Svelte target**, and the `<svelte>` block in the editor.
6. **Library build**: per-target builds for React, Vue and Svelte, CSS files, `"use client"`, types. Verified in fresh Next.js App Router, Vite React, Vite Vue and SvelteKit apps.
7. **Full editor support**: `mf-tsc`, Svelte markup completions, oxfmt and oxlint for `.ucf`.

## 10. Tests

- Splitter: fixture files covering TSX edge cases (`<>` fragments, generics, `a < b`, strings containing `</react>` in TSX → documented limitation), duplicate/unclosed blocks.
- Scope transform: snapshot tests per JSX shape (multiple returns, ternaries, `&&`, fragments, `memo`, `forwardRef`, destructured and non-destructured props).
- Visual parity: render the same component in all targets with Playwright and compare computed styles of key elements.
- SSR: render the React target with `react-dom/server` and hydrate without mismatch warnings.
- Library consumers: build the dist packages and install them into fresh Next.js App Router, Vite React, Vite Vue and SvelteKit apps in CI.
- Imports: automatic per-block imports and the attribute error inside a block (4.1), every rule of 4.2 and their order, static / re-export / dynamic forms, a non-literal attribute error, and that no attribute is left in dev, build or SSR output.
- Types: the same import resolves to the same target in the build and in the TypeScript plugin (one shared fixture set).

## 11. Known risks

- **A `<vue>` block inside another file.** Volar has no built-in way to run Vue's language plugin on a block of another file. We generate the Vue virtual code ourselves with `@vue/language-core`, from same-length SFC code, so its offsets are the `.ucf` offsets. It is nested under our root code. Vue's service plugins read their data from the root, so the root forwards it to the nested code. That relies on internals of `@vue/language-service`, so a test covers it (spike 2 in [plan.md](plan.md)).
- **Svelte tooling is not Volar.** Svelte's language tools run their own server. `svelte2tsx` gives types; markup completions in `.ucf` may lag the other targets.
- **Our TypeScript plugin inside other editors' setups.** Vue's VS Code extension runs on tsserver plugins (hybrid mode), so ours loads beside it, in either order and from one shared install (tested in M4). In tsserver, ours also loads beside `typescript-svelte-plugin`, in either order (tested in M5). Svelte's own language server and `svelte-check` never load tsserver plugins: a `.svelte` file reads the declarations our language server writes on save (`emitSvelteTypes`, `.ucf/svelte/<same path>/Card.ucf.d.ts`), found through `rootDirs`, so they are as fresh as the last save.
- **Attributes surviving each compiler.** The rewrite of 4.4 runs after plugin-vue, the Svelte compiler and Oxc have compiled the importer. Each must keep `with { ... }` on its imports. Test each one.
- **plugin-vue cache misses.** On a miss plugin-vue reads `Card.ucf` from disk and gets the raw file, not our SFC code. Test a dev server restart and SSR.
- **Different exports per target.** Each target's module exports what its block exports. A named export in one block only is allowed, but imports of it fail for the other targets. `mf-tsc` checks every target to catch it early.
- **Tools without our plugin.** Node, plain `tsc` and tools that do not run our plugin reject or ignore `with { framework }`. Only code processed by the plugin may use the attribute.

## 12. Open questions

- Should a target block be allowed to `<style>` locally for target-only overrides?
- `v-bind()` in CSS for React/Svelte: answered, not in v1. It is a `vue-only-style` error there (2); setting the variables on the forwarded roots stays possible later.
- Shared types between targets (props interfaces): a root `<types lang="ts">` block imported by every target?
- Should forwarding of scope attributes be opt-out per component?
