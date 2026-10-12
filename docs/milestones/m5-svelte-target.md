# Milestone 5: Svelte target

## Goal

A `.ucf` file with a `<svelte>` block works as a real Svelte 5 component, in dev, in a build, with SSR and in the editor. One import picks the Svelte target, plugin-svelte compiles it, and the CSS is the shared one: same `data-v-*` scope, same class names as React and Vue. The Svelte library package comes with the library build (milestone 6).

Facts checked while planning (pinned versions below):

- **plugin-svelte picks up our id by default.** Its filter is `^[^?#]+\.svelte(?:[?#]|$)`: the `.svelte` must come before any `?`. Our id `/abs/Card.ucf.svelte.svelte` (spec 4.3) ends in `.svelte`, and plugin-svelte 7.3.0 compiles it with its default filter (M3 spike 3), so users set no `include`.
- **Svelte reserves `$`.** `import $style from '...'` is a compile error (`dollar_prefix_invalid`), and `$style` in markup means "subscribe to a store named `style`". So the build rewrites every `$style` reference to `__ucfStyle` and imports the class map under that name (step 5.2).
- **The Svelte compiler keeps import attributes.** `import X from './Card.ucf' with { framework: 'react' }` and the dynamic form come out unchanged in Svelte's JS output, so the post rewrite of spec 4.4 still sees them (step 5.4 tests it for real).
- **Svelte's language server never loads TypeScript plugins.** svelte-language-server 0.18.4 builds its own language service with its own module loader and does not read the tsconfig `plugins`. So our TypeScript plugin cannot help a `.svelte` importer inside Svelte's editor. Inside tsserver, typescript-svelte-plugin wraps `resolveModuleNameLiterals` and calls the one before it, so both plugins should load side by side (step 5.11).
- **A generated declaration reaches plain TypeScript.** With `rootDirs: ["./src", "./.ucf/svelte/src"]`, `import Card from './Card.ucf'` resolves to `.ucf/svelte/src/Card.ucf.d.ts`. That is the fallback for `.svelte` importers (step 5.11).

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
- How M2 types `$style` in `Card.ucf.react.tsx`: unmapped `declare const` lines built from `ctx.modules` (exact keys, or the loose `{readonly [name: string]: string}` for a module with `classes: undefined`), with a navigation-only mapping from each key to `StyleClass.offset`. The Svelte types script does the same with `__ucfStyle`.
- The Svelte grammar already embedded by `packages/vscode` (highlighting in `<svelte>` needs nothing new).
- The editor test harness in `packages/e2e/editor/`: a real tsserver with our plugin, and an LSP client for our language server.

From milestone 3:

- `resolveTarget(importer, attribute, options)` in core, with: the `.svelte` importer rule, the in-block rule for an importer id `X.ucf.svelte.svelte`, the "imported file has no block for that framework" error, and the `framework`-attribute-inside-a-block error.
- In `@multifront/vite`: the resolve step to the spec 4.3 ids, the style virtual modules `Card.ucf?ucf&type=style&index=N&lang.css`, the class-map virtual module id that `$style` imports, the post plugin of spec 4.4, the `importers` option of `MultifrontOptions`, and the HMR hook (style edit updates styles only, a target edit invalidates only that target).
- The `__ucfScopeAttrs` helper and its virtual module id.
- The warning React gives for a fragment root (its code and how it reaches the user), so a Svelte multi-root warns the same way.
- The scope fuzz harness in `packages/e2e/build/` (seeded generator, replay of a failing seed, its env var in `scripts/lib/env.mjs` `REGISTRY`).

From milestone 4:

- The Vue target in the same Vite app (for mixed apps and the three-target parity check).
- The computed-style parity helper from the browser area.
- What our plugin does with the bare `/abs/Card.ucf` id when `vue` is not in `targets` (step 5.5 depends on it).
- The way M4 (4.3) serves a second target script of a `.ucf` file in tsserver beside the React one. 5.10 serves `Card.ucf.svelte.ts` the same way.

## Steps

### 5.1 The `<svelte>` kind: registry row and `check`

- Build:
  - `packages/core/src/blocks/svelte.ts`: the `svelte` row (`role: 'target'`, grammar scope `source.svelte`) with `check(block)`. Add it to the registry after the shared kinds.
  - `loadSvelteCompiler(root)` in core (`SvelteCompiler` type, in `compilers.ts` beside `loadVueCompiler`, one shared lookup): resolves `svelte/compiler` from the project root (the same copy plugin-svelte uses). `svelte` becomes an optional peer of core (`^5.0.0`); the root and core pin `svelte` 5.57.0 as a devDependency.
  - `check` stays compiler free, like every core check (M1, M4): it keeps M1's `style-inside-target` scan, where a `<style>` inside `<svelte:head>` is plain markup and allowed.
  - The compiler-based rules run in `build()`, which has the project root through `ctx.root` (new `BuildContext` field). They parse with `parse(content, { modern: true })` and report, with `.ucf` line and column:
    - `svelte-parse-error`: Svelte's own parse error (first line of its message), position shifted by `contentStart`.
    - `missing-style-module`: `$style` used with no `<style module>`, or `$name` with no `<style module="name">`, one per use. `$style` is always a class map, even beside a `style` prop, and also reads a `<style module="style">`; any other `$name` whose `name` is declared at the top level of a script is a Svelte store and is left alone. Runes (`$state`, `$props`, …), `$:` and `$$props`, property names (`{$x: 1}`, `o.$x`), import and export names and TypeScript type names are not uses; a computed key or member (`o[$x]`) and `($style as X)` are.
  - Until 5.2 writes the file, a block that passes the rules still ends in `target-not-built`. Every kind now has a `build`, so `BlockKind.build` is required.
- Deliverable: `splitBlocks` plus the registry reports every `<svelte>` rule with exact positions: `checkBlocks` the compiler-free one, `buildTarget(split, ctx, 'svelte')` (Vite's path) all of them.
- Test: core's own tests. `packages/core/test/blocks/svelte.spec.ts`, over real files in `packages/e2e/fixtures/components/svelte/errors/`: `TopLevelStyle.ucf`, `StyleInHead.ucf`, `UnclosedBrace.ucf` (broken `{`), `StyleWithoutModule.ucf`, `WrongModuleName.ucf` (`$style` and `$theme` beside `module="classes"`, computed uses), `NamedModule.ucf` (`$classes` with `module="classes"`, every kind of top-level store, `$`-named imports, exports and types, a `style` prop), `Runes.ucf`, `Legacy.ucf` (`$:`, `$$props`), `ModuleNamedStyle.ucf`. Checks each code, line, column and span; the valid files and every other fixture's `<svelte>` block give no diagnostic. `packages/core/test/compilers.spec.ts` pins the lookup, the "could not find svelte" error (also from `buildTarget`, as a plain error) and a broken compiler's own error.
- Status: done

### 5.2 The `<svelte>` kind: `build`

- Build: `build(block, ctx)` in `packages/core/src/blocks/svelte.ts`, after 5.1's rules, returns a `VirtualFile` with `ext: '.svelte'` in place of 5.1's `target-not-built`, all edits through MagicString over the `.ucf` source, so the map points into the `.ucf` file:
  - Imports: `import '<style id>'` per style block, then `import __ucfStyle from '<class map id>'` per class map the block uses (`$classes` gets `__ucfClasses`; a name the block already binds gets a number suffix). They go into `<script module>` when the block has one (its imports reach the instance script and the markup, so `$style` works there too), else into the instance `<script>`, else into an added `<script>`.
  - Every `$style` / `$name` use that 5.1's rule counts as a class map, in the scripts and in markup expressions, becomes `__ucfStyle` / `__ucfName` (`$style` reads a `module="style"` block when there is no bare `<style module>`). A shorthand keeps its name: `{$style}` in an object becomes `{$style: __ucfStyle}`, `<Child {$style} />` becomes `<Child $style={__ucfStyle} />`. Runes, stores, property, import, export and type names stay as written.
  - When any style is `scoped`: `data-v-<id>=""` right after the tag name of every host element (`RegularElement`, `<svelte:element>`) and every component element (`Component`, `<svelte:component>`, `<svelte:self>`), inside `{#if}`, `{#each}`, `{#await}`, `{#key}`, `{#snippet}` and `<svelte:boundary>`. Not on `<svelte:head>` and its children, `<svelte:window>`, `<svelte:body>`, `<svelte:document>`, `<svelte:options>`, `<svelte:fragment>`, `<slot>`.
  - No `<style>` is ever emitted.
- Deliverable: a `.svelte` file that the real Svelte compiler takes as is.

  ```svelte
  <script lang="ts">
  import '/abs/Card.ucf?ucf&type=style&index=0&lang.css';
  import __ucfStyle from '/abs/Card.ucf?ucf&type=style&index=0&module&lang.js';
    let { title }: { title: string } = $props()
  </script>
  <div data-v-1a2b3c4d="" class={__ucfStyle.card}><h2 data-v-1a2b3c4d="">{title}</h2></div>
  ```

- Test: core's own test, `packages/core/test/blocks/svelte.spec.ts`. Real fixtures in `packages/e2e/fixtures/components/svelte/shapes/`: one per markup shape above (`Elements`, `SvelteElement`, `Components`, `SvelteComponent`, `Slots` with `<svelte:self>` and `<svelte:fragment>`, `IfBlock`, `EachBlock`, `AwaitBlock`, `KeyBlock`, `Snippets`, `Boundary`, `SpecialElements`), plus `LessThan` (`{a < b}`), `AttributeGt` (`>` in attribute values), `CommentedTag` (`<!-- <div> -->`), `ScriptString` (`'<div>'` in script strings), `NoScript` and `ModuleScriptOnly`, and a plain `Child.svelte` the test passes in as the `Child` prop. Each one goes through `build`, then the real `svelte/compiler` `compile` (server and client), and the server code, written to a temp `.js` file (class map imports pointed at files holding what the Vite plugin serves), is rendered with `svelte/server` `render` and read with `htmlparser2` 10.1.0 (a root devDependency; it keeps repeated attributes). Checks: compile gives no error and no warning; only the stamps, the imports and the renames were added; every element from the block carries the scope attribute exactly once, in the code and in the HTML, and nothing in `<svelte:head>` does; class names are the CSS-module ones; no `svelte-` scoping class; the text after each stamp and each `__ucfStyle` trace back to the right `.ucf` line and column. The 5.1 fixtures and every other `<svelte>` block build and compile.
- Status: done

### 5.3 Vite: serve the Svelte id and hand it to plugin-svelte

- Build: in `@multifront/vite`:
  - `load` for `/abs/Card.ucf.svelte.svelte` returns `build()`'s code and map (the split is cached, as for the other targets), and adds the `.ucf` file with `this.addWatchFile`.
  - A clear build error when the Svelte target is needed but plugin-svelte is missing (checked in `configResolved`, by plugin name `vite-plugin-svelte`), or did not compile our id (checked in our post plugin: the code still holds raw Svelte markup, as when the user's `exclude` matches it). The message names the id.
  - Peers: `svelte` ^5 and `@sveltejs/vite-plugin-svelte` ^7, both optional. The package carries the pinned devDependencies that satisfy them, as it does for plugin-vue.
  - A `svelte-floor` CI job (`pnpm devx peer-floor svelte`, as `react-floor` and `vue-floor`) runs every test on the bottom of those ranges.
- Deliverable: a Vite app with `multifront()` and `svelte()` builds a `.ucf` file as a Svelte component.
- Test: build area, `packages/e2e/build/svelte-target.spec.ts`, fixture app `packages/e2e/fixtures/apps/svelte-vite` (real Vite, real plugin-svelte, the shared `fixtures/components/Panel.ucf` from M1, which gains its `<svelte>` block and a `<style module lang="scss">`, and a new `PanelItem.ucf` with all three target blocks. The other shared fixtures gain their `<svelte>` block in this step too: `Counter.ucf`, `imports/Icon.ucf`, `imports/UsesIcon.ucf`). Checks: the output JS is compiled Svelte (no raw markup); the CSS file holds the shared scoped CSS and no Svelte-made CSS; no marker string from the `<vue>` or `<react>` block is in the bundle; the source map points back into `Panel.ucf`. The same app without plugin-svelte fails with our message.

### 5.4 Imports from and into Svelte

- Build: no new rule, only the Svelte cases of milestone 3's resolve and rewrite. Fix whatever the tests find.
- Deliverable: spec 4.1 and 4.2 hold when Svelte is the importer or the imported block.
- Test: build area, `packages/e2e/build/svelte-imports.spec.ts`, with `apps/svelte-vite` and error fixtures in `fixtures/components/svelte/imports/`:
  - A `.svelte` importer with a bare `import Panel from './Panel.ucf'` gets the Svelte target (importer rule).
  - In a `.svelte` file: a static import, a re-export in `<script module>` and a dynamic `import()` with `with { framework: 'svelte' }` all resolve, and no `with {` is left in dev, build or SSR output (the Svelte compiler keeps the attribute; our post plugin removes it).
  - `Panel.ucf`'s `<svelte>` block importing `./PanelItem.ucf` gets PanelItem's Svelte target.
  - A `framework` attribute inside a `<svelte>` block is a build error; importing a file with no `<svelte>` block is a build error naming both files.

### 5.5 Browser render and HMR

- Build: whatever the tests need in the HMR hook. Known trap: plugin-svelte's own `hotUpdate` calls `transformRequest` on the bare file name, `/abs/Panel.ucf`, after a Svelte edit. In an app without the Vue target that id must not throw.
- Add `packages/e2e/fixtures/apps/all-targets`: one Vite app with plugin-vue, plugin-react, plugin-svelte and `multifront()`, rendering `Panel.ucf` three times through `with { framework }`.
- Deliverable: Svelte HMR through our plugin, in a Svelte-only app and in a mixed app.
- Test: browser area, `packages/e2e/browser/svelte-hmr.spec.ts`, Playwright against the dev servers of `apps/svelte-vite` and `apps/all-targets`, editing real copies of the fixtures in a temp folder:
  - Edit the `<svelte>` block: the new text shows, the page does not reload (a value set on `window` survives), no error in the server log or the overlay.
  - Edit a `<style>` block: only the CSS module is fetched again; the Svelte element is the same DOM node.
  - In `all-targets`, edit the `<react>` block: the Svelte module is not fetched again; edit the `<svelte>` block: the React counter keeps its state.

### 5.6 SSR and a SvelteKit app built from `.ucf` sources

- Build: whatever SSR needs (the scope id must be the same on server and client). Add `packages/e2e/fixtures/apps/sveltekit-src`: SvelteKit 2.70.3 with adapter-node, `multifront()` before `sveltekit()`, routes that import `.ucf` files.
- Deliverable: `.ucf` sources render on the server and hydrate in SvelteKit.
- Test: browser area, `packages/e2e/browser/svelte-ssr.spec.ts`. In dev and after `vite build` plus the node server: the SSR HTML has the stamped elements and the CSS link; hydration logs no mismatch warning; the `data-v-*` value is the same in the HTML and after hydration; a button click works. Then restart the dev server and load again (cache miss): still renders.

### 5.7 Scope stamping fuzz (generated real files)

- Build: `packages/e2e/build/svelte-scope.fuzz.spec.ts` on milestone 3's harness. The generator recombines the markup pieces of `fixtures/components/svelte/shapes/` (elements, components, every block and special element of 5.2, nested at random depth, with tricky text) into real `.ucf` files with a scoped style, and writes the same block as a plain `.svelte` file next to it.
- Deliverable: a seeded fuzz run in CI; a failing seed is printed and can be replayed.
- Test: each generated pair goes through real Vite plus real plugin-svelte (SSR build) and is rendered with `svelte/server`. Rules that must always hold:
  - the `.ucf` build never fails when the plain `.svelte` file compiles;
  - every element rendered from the block carries `data-v-<id>` exactly once, and nothing inside `<svelte:head>` does;
  - with the `data-v-*` attributes stripped, the HTML equals the plain `.svelte` file's HTML.

  Each rule is proven by breaking the output on purpose once (drop one stamp, add one twice) and watching it fail.

### 5.8 Root forwarding with `{...rest}`

- Build: in `build()`, for a runes-mode block with exactly one root (descending into `{#if}` / `{:else}`, `{#key}`, `{#await}` branches and `<svelte:boundary>`, each branch with one root):
  - `let { title } = $props()` becomes `let { title, ...__ucfRest } = $props()` (an existing rest name is reused; `let props = $props()` forwards from `props`);
  - each root gets `{...__ucfScopeAttrs(__ucfRest)}`, the helper imported from milestone 3's virtual module.

  More than one root, an `{#each}` root, or a legacy (non-runes) component: no forwarding, plus the same warning React gives for a fragment root.
- Deliverable: a parent's scoped style reaches a Svelte child's root, as in Vue and React.
- Test: browser area, `packages/e2e/browser/svelte-scope-forward.spec.ts`: in `apps/all-targets`, `Panel.ucf` styles `PanelItem`'s root with a scoped rule; its computed style is the same in all three targets. Root shape fixtures in `fixtures/components/svelte/roots/` (if/else roots, a component root, a `<svelte:element>` root, an each root that warns). The 5.7 fuzz gets one more rule: a generated single-root child always has the parent's scope on its root. Required (spec 3.5.1): every framework forwards the same way, so this step is part of the milestone's exit.

### 5.9 Types: `Card.ucf.svelte.ts`

- Build: `packages/language-tools/src/blocks/svelte.ts`, the `types(block, ctx)` half: the same `$style` rewrite and imports as 5.2 (`$style` typed with `declare const` lines from `ctx.modules`, as M2 does for React; no stamping), then `svelte2tsx(code, { filename, isTsFile, mode: 'ts', parse, version })` with the project's own `svelte/compiler` (`loadSvelteCompiler`). The script references `svelte2tsx/svelte-shims-v4.d.ts` and `svelte-jsx-v4.d.ts`. Its default export is a Svelte `Component`. `svelte2tsx` 0.7.61 is a pinned dependency of language-tools, `svelte` an optional peer. The TypeScript plugin resolves to this script for the Svelte target.
- Deliverable: `.ts` importers and other `.ucf` blocks see real Svelte component types.
- Test: editor area, `packages/e2e/editor/svelte-types.spec.ts`, real tsserver with our plugin:
  - a `.ts` file with `import Panel from './Panel.ucf' with { framework: 'svelte' }` sees `Component<{ title: string }>`, and `mount(Panel, { target, props: { title: 1 } })` is a type error;
  - inside `Panel.ucf`'s `<svelte>` block, `./PanelItem.ucf` resolves to `PanelItem.ucf.svelte.ts`;
  - the shared resolution fixture set (spec 10, "Types") gains its Svelte rows, and the build and tsserver pick the same target for each.

### 5.10 The `<svelte>` block in the language server

- Build: the `editor(block, ctx)` half: the `svelte2tsx` output as embedded TypeScript code, served by tsserver with our plugin (hybrid mode, M2). Its source map is turned into Volar mappings: each segment runs to the next one and keeps the length where the source and generated text match. `check` diagnostics show up as well. Markup completions (tags, attributes, component props) are milestone 7.
- Deliverable: errors, hover, go to definition and script completions inside `<svelte>`, including type errors in markup expressions.
- Test: editor area, `packages/e2e/editor/svelte-block.spec.ts`, the real tsserver with our plugin (TypeScript features) and our real language server over LSP (our diagnostics), on `fixtures/components/`:
  - hover on `title` in `{title}` gives `string`;
  - `$style.cardd` is an error at the exact `.ucf` range, and completion after `$style.` lists the class names;
  - go to definition on `<PanelItem>` lands in `PanelItem.ucf`;
  - a top-level `<style>` in the block shows `style-inside-target`.

### 5.11 Svelte's own editor setup

- Build:
  - `emitSvelteTypes({ root, outDir })` in `@multifront/language-tools`: TypeScript declaration emit over every `Card.ucf.svelte.ts`, written as `<outDir>/<same path>/Card.ucf.d.ts` (default `outDir`: `.ucf/svelte`). Our language server calls it when a `.ucf` file with a `<svelte>` block is saved.
  - Docs for a Svelte app: add `"rootDirs": ["./src", "./.ucf/svelte/src"]` to `tsconfig.json`.
  - Update the spec 11 risk "Our TypeScript plugin inside other editors' setups" with what this step shows.
- Deliverable: `.svelte` importers get `.ucf` types in Svelte's editor and in `svelte-check`, and our plugin lives beside Svelte's tsserver plugin.
- Test: editor area, `packages/e2e/editor/svelte-editor-setup.spec.ts`, on `apps/svelte-vite`:
  - real tsserver with `typescript-svelte-plugin` 0.3.52 and our plugin both loaded: a `.ts` file importing a `.svelte` file and a `.ucf` file gets correct types for both;
  - real `svelte-language-server` 0.18.4 over LSP (`svelteserver --stdio`) on a `.svelte` importer: "cannot find module" before `emitSvelteTypes`; after it, the props are typed and a wrong prop is an error;
  - real `svelte-check` 4.7.6 on the app: passes, and fails on a fixture page with a wrong prop.

## Hands to later milestones

For milestone 6 (library build), which builds the Svelte package from these:

- The svelte row's `build(block, ctx)` in `packages/core/src/blocks/svelte.ts`: the `.svelte` code the Svelte package ships, once it can point imports at real files.
- `loadSvelteCompiler(root)` in core, and `svelte` plus `@sveltejs/vite-plugin-svelte` as optional peers of `@multifront/vite`.
- `svelte2tsx` 0.7.61 as a pinned dependency of language-tools (its `emitDts` writes the package's `.d.ts`).
- The `<svelte>` blocks of the shared fixtures (`Counter.ucf`, `Panel.ucf`, `PanelItem.ucf`, `imports/Icon.ucf`), the model for the library fixture's Svelte blocks.

For milestone 7 (full editor support):

- `packages/language-tools/src/blocks/svelte.ts`: `types()` (`Card.ucf.svelte.ts`) for `mf-tsc` checking every target, and `editor()` for adding markup completions on top.
- The source-map-to-Volar-mappings converter of 5.10, for any other tool that gives a source map.
- `emitSvelteTypes({ root, outDir })`, for `mf-tsc` to run it before `svelte-check` in CI.
- `packages/core/src/blocks/svelte.ts` `build()`: the `.svelte` file `mf-lint` hands to oxlint; `mf-fmt` leaves `<svelte>` as written (spec 6.1).
- `loadSvelteCompiler(root)` in core.
- Diagnostic codes `svelte-parse-error` and `missing-style-module`.
- Fixtures: `components/Panel.ucf`, `components/PanelItem.ucf`, `components/svelte/{errors,shapes,imports,roots}/`, apps `svelte-vite`, `sveltekit-src`, `all-targets`.

## Exit test

`packages/e2e/browser/svelte-exit.spec.ts`:

- `apps/all-targets` in dev and after a build: `Panel.ucf` renders as Vue, React and Svelte side by side, the computed styles of the key elements are equal in all three, and the `data-v-*` value is the same.
- An edit to the `<svelte>` block hot-updates without a reload while the React counter keeps its state.
- Scope forwarding is the same in every framework: `Panel.ucf`'s scoped rule reaches `PanelItem`'s root as Vue, React and Svelte (5.8), with equal computed styles.

## Risks and open questions

- **`$style` is renamed under the hood.** Hover shows `__ucfStyle`. The other way was a store: `import style from …` and the class map wrapped as `{ subscribe }`, so `$style` works natively. Rejected because it takes the name `style`, which many Svelte components use for a prop.
- **plugin-svelte's `hotUpdate` transforms the bare file id.** See 5.5. If the bare id cannot be made safe, our HMR hook drops the Svelte module from the list it hands on, and Vite's default update (the compiled module accepts itself) still applies.
- **Svelte names the component `Card_ucf_svelte`** (from the id's file name, `Card.ucf.svelte.svelte`). Only dev messages show it.
- **Svelte 5 HMR resets local state** on a block edit. The tests check "no reload", not "state kept".
- **The fallback declarations need `rootDirs`.** That setting also changes plain `tsc` for `.ts` importers in that project; our plugin and `mf-tsc` override it. Open: write them from the Vite dev server too, so CI without the editor has them?
- **Forwarding is runes-mode only.** Legacy components would need `$$restProps`.
- Names now aligned: the class map id is M1's `classMapId()`, the multi-root warning reuses M3's dev-only `__ucfWarnFragment` helper, the fuzz harness is M3's with M1's env vars.

## Out of scope

- Markup completions in `<svelte>` (tags, attributes, component props): milestone 7.
- `mf-tsc`, `mf-lint`, `mf-fmt` for Svelte blocks: milestone 7. oxfmt does not format Svelte yet.
- `v-bind()` in CSS for Svelte (open question in the spec).
- Svelte 4 and legacy-mode root forwarding.
- Svelte's own `<style>` scoping, and target-only `<style>` in a block (spec open question).
- Custom elements (`<svelte:options customElement>`).
- The Svelte library package and the SvelteKit consumer: milestone 6.
