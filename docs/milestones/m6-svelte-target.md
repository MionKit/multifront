# Milestone 6: Svelte target

## Goal

A `.ucf` file with a `<svelte>` block works as a real Svelte 5 component, in dev, in a build, with SSR and in the editor. One import picks the Svelte target, plugin-svelte compiles it, and the CSS is the shared one: same `data-v-*` scope, same class names as React and Vue. The library build gets its Svelte package: uncompiled `.svelte` files, processed CSS and `.d.ts`, the way `svelte-package` ships them. A fresh SvelteKit app installs it and renders it.

Facts checked while planning (pinned versions below):

- **plugin-svelte does not pick up our id by default.** Its filter is `^[^?#]+\.svelte(?:[?#]|$)`: the `.svelte` must come before the `?`. `/abs/Card.ucf?target=svelte&lang.svelte` fails. A real Vite 8.2.2 build with plugin-svelte 7.3.0 confirms it: default fails, with `include: [/\.ucf\?target=svelte&lang\.svelte$/]` it compiles. `include` is a public option and adds to the default filter. So we ship that regex as `svelteInclude` (step 6.3).
- **Svelte reserves `$`.** `import $style from '...'` is a compile error (`dollar_prefix_invalid`), and `$style` in markup means "subscribe to a store named `style`". So the build rewrites every `$style` reference to `__ucfStyle` and imports the class map under that name (step 6.2).
- **The Svelte compiler keeps import attributes.** `import X from './Card.ucf' with { framework: 'react' }` and the dynamic form come out unchanged in Svelte's JS output, so the post rewrite of spec 4.4 still sees them (step 6.4 tests it for real).
- **Svelte's language server never loads TypeScript plugins.** svelte-language-server 0.18.4 builds its own language service with its own module loader and does not read the tsconfig `plugins`. So our TypeScript plugin cannot help a `.svelte` importer inside Svelte's editor. Inside tsserver, typescript-svelte-plugin wraps `resolveModuleNameLiterals` and calls the one before it, so both plugins should load side by side (step 6.11).
- **A generated declaration reaches plain TypeScript.** With `rootDirs: ["./src", "./.ucf/svelte/src"]`, `import Card from './Card.ucf'` resolves to `.ucf/svelte/src/Card.ucf.d.ts`. That is the fallback for `.svelte` importers (step 6.11).

Pins (every one is older than the 30 day release age rule): `svelte` 5.57.0, `@sveltejs/vite-plugin-svelte` 7.3.0, `svelte2tsx` 0.7.61, `@sveltejs/kit` 2.70.3, `@sveltejs/adapter-node` 5.5.7, `svelte-check` 4.7.6, `svelte-language-server` 0.18.4, `typescript-svelte-plugin` 0.3.52.

## Needs from earlier milestones

From milestone 1:

- `splitBlocks(source, filename)`, its block shape `{ type, attrs, content, start, end, contentStart, contentEnd }` and its error shape `{code, message, line, column}`.
- The `BlockKind` and `VirtualFile` types, the registry in `packages/core/src/blocks/index.ts`, and the test that fails when a tag has only one half. Needed: how a kind lands its core half before its editor half (milestone 4 met the same case with `vue`).
- The `style-inside-target` error code.
- `compileStyles(blocks, {id, filename})` and `scopeId(relativePath, source, production)`.
- `ctx` as the `<style>` kind fills it: the scope id, the class names per module name (`$style` and named modules), the style virtual ids, and whether any style is `scoped`. Exact field names as milestone 1 ships them.
- `packages/e2e` with its areas and `fixtures/` folder.

From milestone 2:

- `@multifront/language-tools` with the Volar language plugin, `packages/language-tools/src/blocks/index.ts`, `./typescript-plugin` and `./server`.
- The `$style` type source the `<style>` kind's `types()` gives the `<react>` virtual script (spec 3.7, `.ucf/types/Card.ucf.d.ts` or its virtual twin), so the Svelte script can import the same one.
- The Svelte grammar already embedded by `packages/vscode` (highlighting in `<svelte>` needs nothing new).
- The editor test harness in `packages/e2e/editor/`: a real tsserver with our plugin, and an LSP client for our language server.

From milestone 3:

- `resolveTarget(importer, attribute, options)` in core, with: the `.svelte` importer rule, the in-block rule for an importer id that carries `?target=svelte`, the "imported file has no block for that framework" error, and the `framework`-attribute-inside-a-block error.
- In `@multifront/vite`: the resolve step to the spec 4.3 ids, the style virtual modules `Card.ucf?ucf&type=style&index=N&lang.css`, the class-map virtual module id that `$style` imports, the post plugin of spec 4.4, the `importers` option of `MultifrontOptions`, and the HMR hook (style edit updates styles only, a target edit invalidates only that target).
- The `__ucfScopeAttrs` helper and its virtual module id.
- The warning React gives for a fragment root (its code and how it reaches the user), so a Svelte multi-root warns the same way.
- The scope fuzz harness in `packages/e2e/build/` (seeded generator, replay of a failing seed, its env var in `scripts/lib/env.mjs` `REGISTRY`).

From milestone 4:

- The Vue target in the same Vite app (for mixed apps and the three-target parity check).
- The computed-style parity helper from the browser area.
- What our plugin does with the bare `/abs/Card.ucf` id when `vue` is not in `targets` (step 6.5 depends on it).

From milestone 5 (exact names as milestone 5 ships them):

- The per-target library build in `@multifront/vite` and its svelte slot.
- The target `package.json` writer, the per-component CSS files and the combined `styles.css`.
- The `.d.ts` step (TypeScript declaration emit over a target's `types()` scripts).
- A library-mode flag in `ctx` that tells a kind to point imports at real relative files instead of virtual ids.
- The fixture library and the consumer harness in `packages/e2e/consumer/` (pack to a tarball, install into a fresh app, build, serve), and the computed styles the Vite React consumer records.

## Steps

### 6.1 The `<svelte>` kind: registry row and `check`

- Build:
  - `packages/core/src/blocks/svelte.ts`: the `svelte` row (`role: 'target'`, grammar scope `source.svelte`) with `check(block)`. Add it to the registry after the shared kinds.
  - `loadSvelteCompiler(root)` in core: resolves `svelte/compiler` from the project root (the same copy plugin-svelte uses). `svelte` becomes an optional peer of core; the root pins `svelte` 5.57.0 as a devDependency.
  - `check` parses the block with `parse(content, { modern: true })` and reports, with `.ucf` line and column:
    - `style-inside-target`: a top-level `<style>` in the block (`ast.css`). A `<style>` inside `<svelte:head>` is plain markup and allowed.
    - `svelte-parse-error`: Svelte's own parse error, position shifted by `contentStart`.
    - `missing-style-module`: `$style` (or `$name`) used with no matching `<style module>` (reuse milestone 3's code if it has one).
- Deliverable: `splitBlocks` plus the registry reports every `<svelte>` rule with exact positions.
- Test: core's own test, `packages/core/test/blocks/svelte.spec.ts`, over real files in `packages/e2e/fixtures/components/svelte/errors/` (style at top level, style in `<svelte:head>`, broken `{`, `$style` without a module, `$classes` with `module="classes"`). Checks each code, line and column; the valid files give no diagnostic.

### 6.2 The `<svelte>` kind: `build`

- Build: `build(block, ctx)` in `packages/core/src/blocks/svelte.ts` returns a `VirtualFile` with `ext: '.svelte'`, all edits through MagicString, map back to the `.ucf` file:
  - In the instance `<script>` (one is added if the block has none, keeping `lang="ts"` when present): `import __ucfStyle from '<class map id>'` per module name (`$classes` gets `__ucfClasses`), and `import '<style id>'` per style block.
  - Every `$style` / `$name` identifier, in the script and in markup expressions, becomes `__ucfStyle` / `__ucfName`. Svelte forbids user names starting with `$`, so every hit is ours.
  - When any style is `scoped`: `data-v-<id>=""` right after the tag name of every host element (`RegularElement`, `<svelte:element>`) and every component element (`Component`, `<svelte:component>`, `<svelte:self>`), inside `{#if}`, `{#each}`, `{#await}`, `{#key}`, `{#snippet}` and `<svelte:boundary>`. Not on `<svelte:head>` and its children, `<svelte:window>`, `<svelte:body>`, `<svelte:document>`, `<svelte:options>`, `<svelte:fragment>`, `<slot>`.
  - No `<style>` is ever emitted.
- Deliverable: a `.svelte` file that the real Svelte compiler takes as is.

  ```svelte
  <script lang="ts">
    import __ucfStyle from '/abs/Card.ucf?ucf&type=style-map…';
    import '/abs/Card.ucf?ucf&type=style&index=0&lang.css';
    let { title }: { title: string } = $props()
  </script>
  <div data-v-1a2b3c4d="" class={__ucfStyle.card}><h2 data-v-1a2b3c4d="">{title}</h2></div>
  ```

- Test: core's own test, `packages/core/test/blocks/svelte.spec.ts`. Real fixtures in `packages/e2e/fixtures/components/svelte/shapes/` (one per markup shape above, plus `{a < b}`, `>` in attribute values, `<!-- <div> -->`, `'<div>'` in script strings, a block with no `<script>`, `<script module>` only). Each one goes through `build`, then the real `svelte/compiler` `compile` with `generate: 'server'`, written to a temp `.js` file and rendered with `svelte/server` `render`. Checks: compile gives no error and no warning; every element from the block carries the scope attribute exactly once; class names are the CSS-module ones; no `svelte-` scoping class; a traced position in the map lands on the right `.ucf` line.

### 6.3 Vite: serve the Svelte id and hand it to plugin-svelte

- Build: in `@multifront/vite`:
  - `load` for `/abs/Card.ucf?target=svelte&lang.svelte` returns `build()`'s code and map (the split is cached, as for the other targets).
  - `export const svelteInclude = /\.ucf\?target=svelte&lang\.svelte$/`, documented as `svelte({ include: [svelteInclude] })`, or `vitePlugin: { include: [svelteInclude] }` in `svelte.config.js` for SvelteKit.
  - A clear build error when the Svelte target is needed but plugin-svelte is missing (checked in `configResolved`, by plugin name `vite-plugin-svelte`), or did not compile our id (checked in our post plugin: the code still holds raw Svelte markup). The message names `svelteInclude`.
  - Peers: `svelte` ^5 and `@sveltejs/vite-plugin-svelte` ^7, both optional. The package carries the pinned devDependencies that satisfy them, as it does for plugin-vue.
  - Update spec 4.3's "Why" cell for svelte and spec 3.6 to say why `include` is needed.
- Deliverable: a Vite app with `multifront()` and `svelte({ include: [svelteInclude] })` builds a `.ucf` file as a Svelte component.
- Test: build area, `packages/e2e/build/svelte-target.spec.ts`, fixture app `packages/e2e/fixtures/apps/svelte-vite` (real Vite, real plugin-svelte, `Panel.ucf` and `PanelItem.ucf` from `fixtures/components/` with `<vue>`, `<react>` and `<svelte>` blocks, a scoped and a module style in SCSS). Checks: the output JS is compiled Svelte (no raw markup); the CSS file holds the shared scoped CSS and no Svelte-made CSS; no marker string from the `<vue>` or `<react>` block is in the bundle; the source map points back into `Panel.ucf`. The same app without `include`, and without plugin-svelte, fails with our message.

### 6.4 Imports from and into Svelte

- Build: no new rule, only the Svelte cases of milestone 3's resolve and rewrite. Fix whatever the tests find.
- Deliverable: spec 4.1 and 4.2 hold when Svelte is the importer or the imported block.
- Test: build area, `packages/e2e/build/svelte-imports.spec.ts`, with `apps/svelte-vite` and error fixtures in `fixtures/components/svelte/imports/`:
  - A `.svelte` importer with a bare `import Panel from './Panel.ucf'` gets the Svelte target (importer rule).
  - In a `.svelte` file: a static import, a re-export in `<script module>` and a dynamic `import()` with `with { framework: 'svelte' }` all resolve, and no `with {` is left in dev, build or SSR output (the Svelte compiler keeps the attribute; our post plugin removes it).
  - `Panel.ucf`'s `<svelte>` block importing `./PanelItem.ucf` gets PanelItem's Svelte target.
  - A `framework` attribute inside a `<svelte>` block is a build error; importing a file with no `<svelte>` block is a build error naming both files.

### 6.5 Browser render and HMR

- Build: whatever the tests need in the HMR hook. Known trap: plugin-svelte's own `hotUpdate` calls `transformRequest` on the bare file name, `/abs/Panel.ucf`, after a Svelte edit. In an app without the Vue target that id must not throw.
- Add `packages/e2e/fixtures/apps/all-targets`: one Vite app with plugin-vue, plugin-react, plugin-svelte and `multifront()`, rendering `Panel.ucf` three times through `with { framework }`.
- Deliverable: Svelte HMR through our plugin, in a Svelte-only app and in a mixed app.
- Test: browser area, `packages/e2e/browser/svelte-hmr.spec.ts`, Playwright against the dev servers of `apps/svelte-vite` and `apps/all-targets`, editing real copies of the fixtures in a temp folder:
  - Edit the `<svelte>` block: the new text shows, the page does not reload (a value set on `window` survives), no error in the server log or the overlay.
  - Edit a `<style>` block: only the CSS module is fetched again; the Svelte element is the same DOM node.
  - In `all-targets`, edit the `<react>` block: the Svelte module is not fetched again; edit the `<svelte>` block: the React counter keeps its state.

### 6.6 SSR and a SvelteKit app built from `.ucf` sources

- Build: whatever SSR needs (the scope id must be the same on server and client). Add `packages/e2e/fixtures/apps/sveltekit-src`: SvelteKit 2.70.3 with adapter-node, `multifront()` before `sveltekit()`, `svelteInclude` in `svelte.config.js`, routes that import `.ucf` files.
- Deliverable: `.ucf` sources render on the server and hydrate in SvelteKit.
- Test: browser area, `packages/e2e/browser/svelte-ssr.spec.ts`. In dev and after `vite build` plus the node server: the SSR HTML has the stamped elements and the CSS link; hydration logs no mismatch warning; the `data-v-*` value is the same in the HTML and after hydration; a button click works. Then restart the dev server and load again (cache miss): still renders.

### 6.7 Scope stamping fuzz (generated real files)

- Build: `packages/e2e/build/svelte-scope.fuzz.spec.ts` on milestone 3's harness. The generator recombines the markup pieces of `fixtures/components/svelte/shapes/` (elements, components, every block and special element of 6.2, nested at random depth, with tricky text) into real `.ucf` files with a scoped style, and writes the same block as a plain `.svelte` file next to it.
- Deliverable: a seeded fuzz run in CI; a failing seed is printed and can be replayed.
- Test: each generated pair goes through real Vite plus real plugin-svelte (SSR build) and is rendered with `svelte/server`. Rules that must always hold:
  - the `.ucf` build never fails when the plain `.svelte` file compiles;
  - every element rendered from the block carries `data-v-<id>` exactly once, and nothing inside `<svelte:head>` does;
  - with the `data-v-*` attributes stripped, the HTML equals the plain `.svelte` file's HTML.

  Each rule is proven by breaking the output on purpose once (drop one stamp, add one twice) and watching it fail.

### 6.8 Root forwarding with `{...rest}` (stretch goal)

- Build: in `build()`, for a runes-mode block with exactly one root (descending into `{#if}` / `{:else}`, `{#key}`, `{#await}` branches and `<svelte:boundary>`, each branch with one root):
  - `let { title } = $props()` becomes `let { title, ...__ucfRest } = $props()` (an existing rest name is reused; `let props = $props()` forwards from `props`);
  - each root gets `{...__ucfScopeAttrs(__ucfRest)}`, the helper imported from milestone 3's virtual module.

  More than one root, an `{#each}` root, or a legacy (non-runes) component: no forwarding, plus the same warning React gives for a fragment root.
- Deliverable: a parent's scoped style reaches a Svelte child's root, as in Vue and React.
- Test: browser area, `packages/e2e/browser/svelte-scope-forward.spec.ts`: in `apps/all-targets`, `Panel.ucf` styles `PanelItem`'s root with a scoped rule; its computed style is the same in all three targets. Root shape fixtures in `fixtures/components/svelte/roots/` (if/else roots, a component root, a `<svelte:element>` root, an each root that warns). The 6.7 fuzz gets one more rule: a generated single-root child always has the parent's scope on its root. If this step is not reliable, it ships without forwarding and the docs say "style Svelte children through `$style`".

### 6.9 Types: `Card.ucf.svelte.ts`

- Build: `packages/language-tools/src/blocks/svelte.ts`, the `types(block, ctx)` half: the same `$style` rewrite and imports as 6.2 (type imports point at milestone 2's `$style` type source, no stamping), then `svelte2tsx(code, { filename, isTsFile, mode: 'ts', parse, version })` with the project's own `svelte/compiler` (`loadSvelteCompiler`). The script references `svelte2tsx/svelte-shims-v4.d.ts` and `svelte-jsx-v4.d.ts`. Its default export is a Svelte `Component`. `svelte2tsx` 0.7.61 is a pinned dependency of language-tools, `svelte` an optional peer. The TypeScript plugin resolves to this script for the Svelte target.
- Deliverable: `.ts` importers and other `.ucf` blocks see real Svelte component types.
- Test: editor area, `packages/e2e/editor/svelte-types.spec.ts`, real tsserver with our plugin:
  - a `.ts` file with `import Panel from './Panel.ucf' with { framework: 'svelte' }` sees `Component<{ title: string }>`, and `mount(Panel, { target, props: { title: 1 } })` is a type error;
  - inside `Panel.ucf`'s `<svelte>` block, `./PanelItem.ucf` resolves to `PanelItem.ucf.svelte.ts`;
  - the shared resolution fixture set (spec 10, "Types") gains its Svelte rows, and the build and tsserver pick the same target for each.

### 6.10 The `<svelte>` block in the language server

- Build: the `editor(block, ctx)` half: the `svelte2tsx` output as embedded TypeScript code. Its source map is turned into Volar mappings: each segment runs to the next one and keeps the length where the source and generated text match. `check` diagnostics show up as well. Markup completions (tags, attributes, component props) are milestone 7.
- Deliverable: errors, hover, go to definition and script completions inside `<svelte>`, including type errors in markup expressions.
- Test: editor area, `packages/e2e/editor/svelte-block.spec.ts`, our real language server over LSP on `fixtures/components/`:
  - hover on `title` in `{title}` gives `string`;
  - `$style.cardd` is an error at the exact `.ucf` range, and completion after `$style.` lists the class names;
  - go to definition on `<PanelItem>` lands in `PanelItem.ucf`;
  - a top-level `<style>` in the block shows `style-inside-target`.

### 6.11 Svelte's own editor setup

- Build:
  - `emitSvelteTypes({ root, outDir })` in `@multifront/language-tools`: TypeScript declaration emit over every `Card.ucf.svelte.ts`, written as `<outDir>/<same path>/Card.ucf.d.ts` (default `outDir`: `.ucf/svelte`). Our language server calls it when a `.ucf` file with a `<svelte>` block is saved.
  - Docs for a Svelte app: add `"rootDirs": ["./src", "./.ucf/svelte/src"]` to `tsconfig.json`.
  - Update the spec 11 risk "Our TypeScript plugin inside other editors' setups" with what this step shows.
- Deliverable: `.svelte` importers get `.ucf` types in Svelte's editor and in `svelte-check`, and our plugin lives beside Svelte's tsserver plugin.
- Test: editor area, `packages/e2e/editor/svelte-editor-setup.spec.ts`, on `apps/svelte-vite`:
  - real tsserver with `typescript-svelte-plugin` 0.3.52 and our plugin both loaded: a `.ts` file importing a `.svelte` file and a `.ucf` file gets correct types for both;
  - real `svelte-language-server` 0.18.4 over LSP (`svelteserver --stdio`) on a `.svelte` importer: "cannot find module" before `emitSvelteTypes`; after it, the props are typed and a wrong prop is an error;
  - real `svelte-check` 4.7.6 on the app: passes, and fails on a fixture page with a wrong prop.

### 6.12 Library output for Svelte

- Build: the svelte slot of milestone 5's library build. Per component, in `dist/svelte/`:
  - `Panel.svelte` from `build()` in library mode: the class map inlined as `const __ucfStyle = {…}`, `import './Panel.css'`, `.ucf` imports rewritten to `./PanelItem.svelte`, the forward helper shipped once as `_ucf/scopeAttrs.js`;
  - `Panel.css` (processed: scoped selectors, module class names) and the combined `styles.css`;
  - `Panel.svelte.d.ts` from `svelte2tsx`'s `emitDts` (the tool `svelte-package` uses) over the emitted files;
  - `index.js` and `index.d.ts` re-exporting every component;
  - `package.json`: `exports` with `types` and `svelte` conditions, `"svelte": "./index.js"`, peer `svelte` ^5, no dependencies, `"sideEffects": ["*.css"]`.
- Deliverable: `dist/svelte/` that follows the `svelte-package` layout.
- Test: build area, `packages/e2e/build/svelte-library.spec.ts`, on milestone 5's fixture library: the file list; every `.svelte` file compiles with the real Svelte compiler with no reference to a `.ucf` file or a virtual id; `tsc` over `index.d.ts` with the svelte shims passes; `package.json` has no `dependencies`.

### 6.13 SvelteKit consumer

- Build: `packages/e2e/fixtures/apps/consumer-sveltekit` (SvelteKit 2.70.3, adapter-node, nothing from multifront) and the consumer spec on milestone 5's harness.
- Deliverable: the packed Svelte package works in a fresh SvelteKit app.
- Test: consumer area, `packages/e2e/consumer/sveltekit.spec.ts`: pack the library, install the tarball, run `svelte-check` (passes; a page with a wrong prop fails), `vite build`, start the node server, then Playwright: the SSR HTML has the `data-v-*` elements, the CSS loads as a file, hydration logs no warning, a click works, and the computed styles of key elements equal milestone 5's Vite React consumer.

## Hands to later milestones

All for milestone 7 (full editor support):

- `packages/language-tools/src/blocks/svelte.ts`: `types()` (`Card.ucf.svelte.ts`) for `mf-tsc` checking every target, and `editor()` for adding markup completions on top.
- The source-map-to-Volar-mappings converter of 6.10, for any other tool that gives a source map.
- `emitSvelteTypes({ root, outDir })`, for `mf-tsc` to run it before `svelte-check` in CI.
- `packages/core/src/blocks/svelte.ts` `build()`: the `.svelte` file `mf-lint` hands to oxlint; `mf-fmt` leaves `<svelte>` as written (spec 6.1).
- `loadSvelteCompiler(root)` in core.
- `svelteInclude` from `@multifront/vite`.
- Diagnostic codes `svelte-parse-error` and `missing-style-module`.
- Fixtures: `components/Panel.ucf`, `components/PanelItem.ucf`, `components/svelte/{errors,shapes,imports,roots}/`, apps `svelte-vite`, `sveltekit-src`, `all-targets`, `consumer-sveltekit`.

## Exit test

`packages/e2e/browser/svelte-exit.spec.ts`, plus 6.13 in the same CI job:

- `apps/all-targets` in dev and after a build: `Panel.ucf` renders as Vue, React and Svelte side by side, the computed styles of the key elements are equal in all three, and the `data-v-*` value is the same.
- An edit to the `<svelte>` block hot-updates without a reload while the React counter keeps its state.
- The SvelteKit consumer of 6.13 passes.

## Risks and open questions

- **`include` is a user step.** Zero-config would mean pushing our regex into plugin-svelte's `api.filter.id.include` from our `configResolved` (its `vite-plugin-svelte:config` plugin exposes an `api` object, but it is not documented). Plan: public `include` plus a clear error. Open: is zero-config worth leaning on that object?
- **`$style` is renamed under the hood.** Hover shows `__ucfStyle`. The other way was a store: `import style from …` and the class map wrapped as `{ subscribe }`, so `$style` works natively. Rejected because it takes the name `style`, which many Svelte components use for a prop.
- **plugin-svelte's `hotUpdate` transforms the bare file id.** See 6.5. If the bare id cannot be made safe, our HMR hook drops the Svelte module from the list it hands on, and Vite's default update (the compiled module accepts itself) still applies.
- **Svelte names the component `Card_ucf`** (from `filename`). Only dev messages show it.
- **Svelte 5 HMR resets local state** on a block edit. The tests check "no reload", not "state kept".
- **The fallback declarations need `rootDirs`.** That setting also changes plain `tsc` for `.ts` importers in that project; our plugin and `mf-tsc` override it. Open: write them from the Vite dev server too, so CI without the editor has them?
- **Forwarding is runes-mode only.** Legacy components would need `$$restProps`.
- Milestone names to align: the library-mode flag in `ctx`, the class-map virtual id, the fragment-root warning code, the fuzz harness and its env var.

## Out of scope

- Markup completions in `<svelte>` (tags, attributes, component props): milestone 7.
- `mf-tsc`, `mf-lint`, `mf-fmt` for Svelte blocks: milestone 7. oxfmt does not format Svelte yet.
- `v-bind()` in CSS for Svelte (open question in the spec).
- Svelte 4 and legacy-mode root forwarding.
- Svelte's own `<style>` scoping, and target-only `<style>` in a block (spec open question).
- Custom elements (`<svelte:options customElement>`).
