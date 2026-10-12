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
  - `loadSvelteCompiler(root)` in core (`SvelteCompiler` type, in `compilers.ts` beside `loadVueCompiler`, one shared lookup): resolves `svelte/compiler` from the project root (the same copy plugin-svelte uses). `svelte` becomes an optional peer of core (`^5.55.6`, the floor 5.3 tested); the root and core pin `svelte` 5.57.0 as a devDependency.
  - `check` stays compiler free, like every core check (M1, M4): it keeps M1's `style-inside-target` scan, where a `<style>` inside `<svelte:head>` is plain markup and allowed.
  - The compiler-based rules run in `build()`, which has the project root through `ctx.root` (new `BuildContext` field). They parse with `parse(content, { modern: true })` and report, with `.ucf` line and column:
    - `svelte-parse-error`: Svelte's own parse error (first line of its message), position shifted by `contentStart`.
    - `missing-style-module`: `$style` used with no `<style module>`, or `$name` with no `<style module="name">`, one per use. `$style` is always a class map, even beside a `style` prop, and also reads a `<style module="style">`; any other `$name` whose `name` is declared at the top level of a script is a Svelte store and is left alone. Runes (`$state`, `$props`, …), `$:` and `$$props`, property names (`{$x: 1}`, `o.$x`), import and export names and TypeScript type names are not uses; a computed key or member (`o[$x]`) and `($style as X)` are.
  - Until 5.2 writes the file, a block that passes the rules still ends in the not-built error. Every kind now has a `build`, so `BlockKind.build` is required.
- Deliverable: `splitBlocks` plus the registry reports every `<svelte>` rule with exact positions: `checkBlocks` the compiler-free one, `buildTarget(split, ctx, 'svelte')` (Vite's path) all of them.
- Test: core's own tests. `packages/core/test/blocks/svelte.spec.ts`, over real files in `packages/e2e/fixtures/components/svelte/errors/`: `TopLevelStyle.ucf`, `StyleInHead.ucf`, `UnclosedBrace.ucf` (broken `{`), `StyleWithoutModule.ucf`, `WrongModuleName.ucf` (`$style` and `$theme` beside `module="classes"`, computed uses), `NamedModule.ucf` (`$classes` with `module="classes"`, every kind of top-level store, `$`-named imports, exports and types, a `style` prop), `Runes.ucf`, `Legacy.ucf` (`$:`, `$$props`), `ModuleNamedStyle.ucf`. Checks each code, line, column and span; the valid files and every other fixture's `<svelte>` block give no diagnostic. `packages/core/test/compilers.spec.ts` pins the lookup, the "could not find svelte" error (also from `buildTarget`, as a plain error) and a broken compiler's own error.
- Status: done

### 5.2 The `<svelte>` kind: `build`

- Build: `build(block, ctx)` in `packages/core/src/blocks/svelte.ts`, after 5.1's rules, returns a `VirtualFile` with `ext: '.svelte'` in place of 5.1's not-built error, all edits through MagicString over the `.ucf` source, so the map points into the `.ucf` file:
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

- Test: core's own test, `packages/core/test/blocks/svelte.spec.ts`. Real fixtures in `packages/e2e/fixtures/components/svelte/shapes/`: one per markup shape above (`Elements`, `SvelteElement`, `Components`, `SvelteComponent`, `Slots` with `<svelte:self>` and `<svelte:fragment>`, `IfBlock`, `EachBlock`, `AwaitBlock`, `KeyBlock`, `Snippets`, `Boundary`, `SpecialElements`), plus `LessThan` (`{a < b}`), `AttributeGt` (`>` in attribute values), `CommentedTag` (`<!-- <div> -->`), `ScriptString` (`'<div>'` in script strings), `NoScript`, `ModuleScriptOnly` and `BothScripts`, and a plain `Child.svelte` the test passes in as the `Child` prop. Each one goes through `build`, then the real `svelte/compiler` `compile` (server and client), and the server code, written to a temp `.js` file (class map imports pointed at files holding what the Vite plugin serves), is rendered with `svelte/server` `render` and read with `htmlparser2` 10.1.0 (a root devDependency; it keeps repeated attributes). Checks: compile gives no error and no warning; only the stamps, the imports and the renames were added; every element from the block carries the scope attribute exactly once, in the code and in the HTML, and nothing in `<svelte:head>` does; class names are the CSS-module ones; no `svelte-` scoping class; the text after each stamp and each `__ucfStyle` trace back to the right `.ucf` line and column. The 5.1 fixtures and every other `<svelte>` block build and compile; `svelte/NoStyle.ucf` (no script, no style) builds to its block content.
- Status: done

### 5.3 Vite: serve the Svelte id and hand it to plugin-svelte

- Build: in `@multifront/vite`:
  - `load` for `/abs/Card.ucf.svelte.svelte` returns `build()`'s code and map (the split is cached, as for the other targets), and adds the `.ucf` file with `this.addWatchFile`.
  - A clear build error when the Svelte target is needed but plugin-svelte is missing (found by plugin name `vite-plugin-svelte`; the import fails with "the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins (it compiles <id>)", naming the importer), or did not compile our id (`multifront:svelte-compiled`, a post plugin before the attribute rewrite: the code has no `svelte/internal/client` or `/server` import, as when the user's `exclude` matches it). The message names the id.
  - Peers: `svelte` `^5.55.6` and `@sveltejs/vite-plugin-svelte` `^7.0.0`, both optional (plugin-svelte 7 needs svelte 5.46.4 or later; below 5.55.6 the server render drops a dotted component read from `$derived` (`<ui.Child>`) and older releases write other hydration markers). The package carries the pinned devDependencies that satisfy them, as it does for plugin-vue.
  - plugin-svelte hands `getCombinedSourcemap()` to the Svelte compiler, which merges our `load` map into its own; Vite then applies our map a second time and every mapping is lost. `composeSveltePlugin(config)` (`packages/vite/src/svelteTarget.ts`, from `configResolved`) wraps plugin-svelte's compile `transform` so that for our ids it sees no previous map.
  - A `svelte-floor` CI job (`pnpm devx peer-floor svelte`, as `react-floor` and `vue-floor`) runs every test on the bottom of those ranges.
- Deliverable: a Vite app with `multifront()` and `svelte()` builds a `.ucf` file as a Svelte component.
- Test: build area, `packages/e2e/build/svelte-target.spec.ts`, fixture app `packages/e2e/fixtures/apps/svelte-vite` (real Vite, real plugin-svelte, the shared `fixtures/components/Panel.ucf` from M1, which gains its `<svelte>` block rendering `PanelItem` and a `<style module lang="scss">`; its `<vue>` and `<react>` blocks stay as they are. A new `PanelItem.ucf` has all three target blocks. The other shared fixtures gain their `<svelte>` block in this step too: `Counter.ucf`, `imports/Icon.ucf`, `imports/UsesIcon.ucf`). Checks: the output JS is compiled Svelte (no raw markup) with Panel's production scope id; the CSS file holds the shared scoped CSS and no Svelte-made CSS; no marker string from PanelItem's `<vue>` or `<react>` block is in the bundle; the source map points back into `Panel.ucf`'s `<svelte>` block, in the build and in dev. The same app without plugin-svelte, or with plugin-svelte excluding our ids, fails with our message. The imports app's configs gain `svelte()`.
- Status: done

### 5.4 Imports from and into Svelte

- Build: no new rule, only the Svelte cases of milestone 3's resolve and rewrite, plus what the tests found:
  - `svelteKind.check` reports `framework-in-block` on every framework attribute in the block's top-level `<script>` and `<script module>`, at its `.ucf` span, through the helper `vueKind.check` uses (`frameworkInBlock` in `packages/core/src/imports/rewrite.ts`, oxc only, every script in the block's first `lang`). An `import()` in markup is left to the post rewrite of the compiled module, which fails at its specifier.
  - `multifront:importers` in `@multifront/vite` (pre, M4's `.vue` check, now also for `.svelte` files): checks a `.svelte` file's own scripts (in the language of the first `lang`, as Svelte does; a preprocessed `<style>` blanked first) before plugin-svelte and its preprocessors run, so an import error carries the importer's absolute path in dev too (plugin-svelte's map names the file relatively, and Vite's dev errors pass that name on).
- Deliverable: spec 4.1 and 4.2 hold when Svelte is the importer or the imported block.
- Test: build area, `packages/e2e/build/svelte-imports.spec.ts`, with `apps/svelte-vite` (`src/App.svelte`, mounted by `src/app.ts`, rendered by `src/entry-server.ts`) and error fixtures in `fixtures/components/svelte/imports/` (`AttrInSvelte.ucf`, `AttrInSvelteMarkup.ucf`, `UsesReactOnly.ucf`; `svelte/errors/ImportParseError.ucf` for core):
  - A `.svelte` importer with a bare `import Panel from './Panel.ucf'` gets the Svelte target (importer rule).
  - In a `.svelte` file: a static import, a re-export in `<script module>` and a dynamic `import()` with `with { framework: 'svelte' }` all resolve, and no `with {` is left in dev, build or SSR output (the Svelte compiler keeps the attribute; our post plugin removes it).
  - `Panel.ucf`'s `<svelte>` block importing `./PanelItem.ucf` gets PanelItem's Svelte target.
  - A `framework` attribute inside a `<svelte>` block is a build error; importing a file with no `<svelte>` block is a build error naming both files.
  - A `.svelte` importer's `unknown-framework` and `framework-attribute-not-literal` fail at the import, with its absolute path, in a build with no source maps and in dev: first in the file whichever script holds it, a lang-less `<script module>` read as TypeScript, and with `vitePreprocess()`.
  - The `imports` app's `src/Gallery.svelte` row runs in `build/imports.spec.ts`.
- Status: done

### 5.5 Browser render and HMR

- Build:
  - plugin-svelte's own `hotUpdate` calls `transformRequest` on the bare file name, `/abs/Panel.ucf`, after a Svelte edit. That is the Vue id: without plugin-vue it throws (error overlay, no update), with it every Svelte edit compiles the Vue target. `composeSveltePlugin(config)` (`packages/vite/src/svelteTarget.ts`) also wraps the handler of `vite-plugin-svelte:hot-update`: for a `.ucf` file, its `transformRequest` of that one bare file resolves `null` untransformed. The request only refreshes plugin-svelte's Svelte CSS, which our ids never emit. Every other URL, our `.ucf.svelte.svelte` module included, is transformed as before.
  - `trackHmrPayloads()` in `browser/lib/requests.ts` gains `errors()`, the messages of Vite's `error` payloads.
- Add `packages/e2e/fixtures/apps/all-targets`: one Vite app with plugin-react, plugin-vue, plugin-svelte and `multifront()`. `src/main.tsx` renders `Panel.ucf` three times through `with { framework }` (into `#vue`, `#react`, `#svelte`), plus the React `Counter.ucf` (`start={2}`) in `#react`, `svelte/NoStyle.ucf` (no `<vue>` block) in `#no-style` and a plain `src/Plain.svelte` with a `<style>` in `#plain`.
- Deliverable: Svelte HMR through our plugin, in a Svelte-only app and in a mixed app.
- Test: browser area, `packages/e2e/browser/svelte-hmr.spec.ts`, Playwright against the dev servers of `apps/svelte-vite` and `apps/all-targets`, editing real copies of the fixtures in a temp folder:
  - Edit the `<svelte>` block: the new text shows, the page does not reload (a value set on `window` survives), no error in the server log or the overlay.
  - Edit a `<style>` block: only the CSS module is fetched again (in `all-targets` also plugin-vue's style sub-module of that block, for the Vue panel); the Svelte element is the same DOM node.
  - In `all-targets`, edit the `<react>` block: the Svelte module is not fetched again; edit the `<svelte>` block: the React counter keeps its state.
  - In `all-targets`, a `<svelte>` edit to `NoStyle.ucf` (no `<vue>` block) updates it without an error, and `Plain.svelte` still hot-updates its markup and its style.
- Status: done

### 5.6 SSR and a SvelteKit app built from `.ucf` sources

- Build: whatever SSR needs (the scope id must be the same on server and client): no plugin change was needed. Add `packages/e2e/fixtures/apps/sveltekit-src`: SvelteKit 2.70.3 with adapter-node 5.5.7 (root devDependencies), `multifront()` before `sveltekit()`. Routes: `/` imports `Panel.ucf` and `Counter.ucf` and links to `/items`, which imports `PanelItem.ucf`. SvelteKit's client build reloads `vite.config.ts` with Vite's bundling loader, which ignores the `source` condition, so the config imports `@multifront/vite` through a computed specifier. Helpers in `build/lib/freshProcess.ts`: `startViteDev(root)` (`vite` on a free port) and `startNodeServer(root)` (the adapter-node server).
- Deliverable: `.ucf` sources render on the server and hydrate in SvelteKit.
- Test: browser area, `packages/e2e/browser/svelte-ssr.spec.ts`. In dev and after `vite build` plus the node server: the SSR HTML has the stamped elements and their scoped CSS (in dev SvelteKit inlines it as `<style data-sveltekit>`, a build links its files); hydration logs no warning and keeps the server-rendered node; the `data-v-*` value is the same in the HTML, after hydration and on `/items` rendered by the client after a link click; a button click works. Then a new dev server process on the same copy (cache miss): still renders and hydrates.
- Status: done

### 5.7 Scope stamping fuzz (generated real files)

- Build: `packages/e2e/build/svelte-scope.fuzz.spec.ts` on milestone 3's harness. The generator, `packages/e2e/build/lib/svelteScopeFuzz.ts`, recombines the markup pieces of `fixtures/components/svelte/shapes/` (elements, components, every block and special element of 5.2, nested at random depth, with tricky text) into real `.ucf` files with a scoped style, and writes the same block as a plain `.svelte` file next to it, which reads `$style` as a Svelte store of the `.ucf` file's class map (`readable`), so only our stamps and rename differ.
- Deliverable: a seeded fuzz run in CI; a failing seed is printed and can be replayed.
- Test: each generated pair goes through real Vite plus real plugin-svelte (SSR build) and is rendered with `svelte/server`. Rules that must always hold:
  - the `.ucf` build never fails when the plain `.svelte` file compiles;
  - every element rendered from the block carries `data-v-<id>` exactly once, and nothing inside `<svelte:head>` does;
  - with the `data-v-*` attributes stripped, the HTML equals the plain `.svelte` file's HTML.

  Each rule is proven by breaking the output on purpose once (drop one stamp, add one twice) and watching it fail. CI runs 300 files with a fixed seed (2026); the HTML comparison ignores Svelte's `<svelte:head>` key comment, a hash of the file name.
- Status: done

### 5.8 Root forwarding with `{...rest}`

- Build: `packages/core/src/svelte/forward.ts`, called by `build()`, for a runes-mode block with exactly one root per branch (descending into `{#if}` / `{:else}`, `{#key}`, `{#await}` branches and `<svelte:boundary>` with its `failed` / `pending` snippets; comments, snippets, `{@const}`, `{@debug}` and `<svelte:head|window|body|document>` are no roots). The mode is Svelte's own rule, read from the block: `<svelte:options runes>`, else a rune reference (a `$state` of a top-level store is no rune; `let props = $props()` and svelte/store's `derived` beside `$derived` keep it one) makes it runes; `export let`, `$:`, `$$props` or `$$restProps` make it legacy; a block with neither is undecided (plugin-svelte's `compilerOptions.runes` decides) and gets no edit at all.
  - `let { title } = $props()` becomes `let { title, ...__ucfRest } = $props()` (an existing rest name is reused; `let props = $props()` forwards from `props`; with no `$props()` at all, `let __ucfRest = $props();` is added; a `{:then props}` or snippet parameter around a root that hides that name gets `const __ucfProps = $derived(props);`);
  - each element or component root gets `{...__ucfScopeAttrs(__ucfRest)}` right after its stamp, the helper imported from milestone 3's virtual module. A text, `{@render}`, `{@html}` or `<slot>` root gets nothing and no warning, as React's `null` and `children` roots;
  - beside that spread, Svelte 5.57's server render escapes a plain-text attribute value twice (`data-x="<b>"` renders `&amp;lt;b>`), so such a value on a forwarded root becomes an expression (`data-x={"<b>"}`); an `on…` attribute stays text, for Svelte's own `attribute_invalid_event_handler`.

  More than one root, an `{#each}` root, or a legacy component: no forwarding, plus, in dev only, the warning React gives for a fragment root through the same `__ucfWarnFragment`, which takes Svelte's own `problem` and `fix`: "renders more than one root", "renders an {#each} block as its root", or "is a legacy-mode Svelte component" with "Use $props() to make it a runes-mode component.". It runs once at init, from the instance script (inside an arrow called at once in runes mode, which Svelte would otherwise flag as `state_referenced_locally`).
- Deliverable: a parent's scoped style reaches a Svelte child's root, as in Vue and React.
- Test: browser area, `packages/e2e/browser/svelte-scope-forward.spec.ts`, dev and preview: in `apps/all-targets`, `Panel.ucf` (whose `<vue>` and `<react>` blocks now render `PanelItem` too) styles `PanelItem`'s root with a scoped `.item` rule; its computed style is the same in all three targets. Root shape fixtures in `fixtures/components/svelte/roots/` (if/else, `{#key}` / boundary / `{#await}` roots with their `{:catch}` and `failed` branches, a component root `PassOnRoot`, a `<svelte:element>` root, rest and props-object forms, added `$props()`, escaped attributes, a shadowed props name, and `EachRoot`, `MultiRoot`, `LegacyRoot`, `LegacyStoreRoot` that warn), rendered by `apps/all-targets/Roots.ucf` on `?page=roots`; core's own test (`packages/core/test/svelte/forward.spec.ts`) builds, compiles and server-renders each. The 5.7 fuzz gets one more rule, `forwards`: every case renders through a real scoped `Parent.ucf`, and a generated single-root runes child always has the parent's scope on its root and nowhere else. Required (spec 3.5.1): every framework forwards the same way, so this step is part of the milestone's exit.
- Status: done

### 5.9 Types: `Card.ucf.svelte.ts`

- Build: `packages/language-tools/src/blocks/svelte.ts`, the `types(block, ctx)` half: the same `$style` rewrite as 5.2 through core's `renameSvelteStyles(block, split, compiler, modules)` (`build()`'s rename alone: no stamping, no imports, no forwarding; Svelte's loose parser; never throws), then `svelte2tsx(code, { filename, isTsFile, mode: 'ts', parse, version, emitOnTemplateError: true })` with the project's own `svelte/compiler` (`loadSvelteCompiler`; `SvelteCompiler` gains `VERSION`). The script references `svelte2tsx/svelte-shims-v4.d.ts` and `svelte-jsx-v4.d.ts` by path (`EditorOptions.svelteTypesRoot`, default the installed svelte2tsx), and ends with `declare const __ucfStyle: …` lines from `ctx.modules` for each class map the block uses, as M2 does for React. Its default export is a Svelte `Component`. `svelte2tsx` 0.7.61 is a pinned dependency of language-tools, `svelte` an optional peer.
  - `editor()` returns that script (TypeScript or JavaScript by the scripts' `lang`) and `serviceScript` serves it, so tsserver serves `Card.ucf.svelte.ts` beside the React and Vue scripts, and an import inside the block resolves from it (block rule). Its only mappings are the class map keys; 5.10 adds the block's.
  - The TypeScript plugin loads the project's Svelte compiler (`EditorOptions.svelteCompiler`) and resolves every svelte pick to this script. With no Svelte installed there is no script: the pick is TypeScript's own `TS2307`, and the tsserver log says why. The "no types yet" error of M2 is gone, in the editor and the build alike.
  - Definitions that fall back to the same spot of a `.ucf` file come back once (svelte2tsx declares the component as a value and a type).
  - The VS Code pack: svelte2tsx imports TypeScript and Svelte's compiler at load, and the `.vsix` ships neither. `pnpm devx vsix` points its `typescript` import at the copy tsserver hands the plugin (`packages/vscode/src/bundle/hostTypeScript.cjs`) and its compiler at a stub, and copies the shims to `dist/svelte-types/` (`createTypeScriptPlugin({svelteTypesRoot})`). The shims' `import('svelte')` needs no install beside them: Svelte's types declare `module 'svelte'` globally.
- Deliverable: `.ts` importers and other `.ucf` blocks see real Svelte component types.
- Test: editor area, `packages/e2e/editor/svelte-types.spec.ts`, real tsserver with our plugin on `apps/svelte-vite` (new `tsconfig.json`):
  - `src/main.ts` with `import Panel from '../../../components/Panel.ucf' with { framework: 'svelte' }` sees a `Component` whose `heading` prop is `string`, and `mount(Panel, { target, props: { heading: 1 } })` is one `TS2322` at `heading`; definition on `Panel` lands in `Panel.ucf`;
  - inside `Panel.ucf`'s `<svelte>` block, `./PanelItem.ucf` resolves to `PanelItem.ucf.svelte.ts` (an unsaved edit typing `heading` as `typeof PanelItem` gives `main.ts` a Svelte `Component`, and `resolveUcfImport` over `getTypesScript`'s code);
  - the shared resolution fixture set (spec 10, "Types"): its Svelte rows (`src/lazy.ts`, `src/attribute-over-importer.tsx`, `custom-importers/widget.ts`, `src/Gallery.svelte`) resolve to svelte in the build (`build/imports.spec.ts`) and in tsserver (`editor/imports.spec.ts`: no error, definition on `Card.ucf`, a binding typed `Component`). `src/Gallery.svelte`'s tsserver side needs Svelte's own TypeScript plugin: 5.11 lists it in its Test.
  - Also: `bundle.spec.ts`, the pack gives a svelte pick a `Component` with the shims beside the bundle; `vsix.spec.ts` packs them; `tsserver.spec.ts`, a project with no Svelte gets `TS2307` and the log line.
- Status: done

### 5.10 The `<svelte>` block in the language server

- Build: the `editor(block, ctx)` half: the `svelte2tsx` output as embedded TypeScript code, served by tsserver with our plugin (hybrid mode, M2). `sourceMapMappings(map, source, generated, data)` (`packages/language-tools/src/mappings.ts`) turns a source map into Volar mappings: each segment runs to the next one; where the source and generated text match it maps 1:1 (TypeScript errors, hover, completion, navigation), the rest of the run maps to the point the match ended, for diagnostics only (svelte2tsx writes the prop `label` as `"label"`). svelte2tsx reads the renamed block, so its mappings go through `composeMappings` with those of the rename, whose source map `mappings` `renameSvelteStyles` now returns; a renamed use maps whole, `$style` to `__ucfStyle`, shorthands included. While typing, `renameSvelteStyles` also renames a class map `$name` lexically in text Svelte cannot read (`{$style.}`, a script syntax error), so `$style.` completes. `check` diagnostics show up as well: our language server reports `style-inside-target`, tsserver `framework-in-block` at the specifier. Markup completions (tags, attributes, component props) are milestone 7.
- Deliverable: errors, hover, go to definition and script completions inside `<svelte>`, including type errors in markup expressions.
- Test: editor area, `packages/e2e/editor/svelte-block.spec.ts`, the real tsserver with our plugin (TypeScript features) and our real language server over LSP (our diagnostics), on `fixtures/components/`:
  - hover on `heading` in `{heading}` gives `string`, and definition lands on its `$props()` binding; hover on `{count}` in `Counter.ucf` and `vue/CounterCrlf.ucf`;
  - `$style.cardd` is an error at the exact `.ucf` range, and completion after `$style.` lists the class names, also while typing `{$style.}` and in a script that does not parse; hover on `$style`, a shorthand one included, definition on a class name;
  - type errors in markup expressions (`{heading.toFixed(2)}`, a wrong prop on `<PanelItem>`) at their `.ucf` range;
  - go to definition on `<PanelItem>` lands in `PanelItem.ucf`;
  - the shared fixtures' `<svelte>` blocks give no error as written;
  - a top-level `<style>` in the block shows `style-inside-target`; `svelte/imports/AttrInSvelte.ucf` gets `framework-in-block` from tsserver at its three specifiers;
  - every mapping of every `<svelte>` fixture is the same text on both sides, a renamed class map, or a diagnostics-only point, inside the block.
- Status: done

### 5.11 Svelte's own editor setup

- Build:
  - `emitSvelteTypes({ root, outDir, ts, svelteTypesRoot })` in `@multifront/language-tools` (`src/svelteDeclarations.ts`): TypeScript declaration emit over every `Card.ucf.svelte.ts` under `root` (`.ucf` imports resolved by the block rule, as tsserver does; a JS block parsed as JS), written as `<outDir>/<same path>/Card.ucf.d.ts` (default `outDir`: `.ucf/svelte`). A declaration whose `.ucf` file is gone or has no `<svelte>` block is deleted; a block whose markup does not parse keeps its last one. `ts` defaults to the project's own `typescript`.
  - Our language server calls it when a `.ucf` file with a `<svelte>` block (or an existing declaration) is saved, for the deepest workspace folder holding it, once per burst of saves. `startServer(options: ServerOptions)` takes `svelteTypesRoot` and `onTypeScript`: the VS Code bundle's own entry, `packages/vscode/src/server.ts`, points svelte2tsx's `typescript` import at the tsdk's copy and its shims at `dist/svelte-types/`.
  - Docs for a Svelte app: add `"rootDirs": ["./src", "./.ucf/svelte/src"]` to `tsconfig.json` and `.ucf/` to `.gitignore`.
  - Update the spec 11 risk "Our TypeScript plugin inside other editors' setups" with what this step shows.
  - Root devDependencies: `svelte-language-server` 0.18.4, `typescript-svelte-plugin` 0.3.52, `svelte-check` 4.7.6. `apps/svelte-vite` gains `rootDirs` and `src/mountAll.ts`, and imports `@multifront/vite` through a computed specifier (svelte-check and Svelte's server load its config with Vite's bundling loader, as SvelteKit does in 5.6).
- Deliverable: `.svelte` importers get `.ucf` types in Svelte's editor and in `svelte-check`, and our plugin lives beside Svelte's tsserver plugin.
- Test: editor area, `packages/e2e/editor/svelte-editor-setup.spec.ts`, on copies of `apps/svelte-vite` (helpers in `editor/lib/svelte.ts`):
  - `emitSvelteTypes` writes one declaration per `.ucf` file whose `<svelte>` block tsserver serves a script for, and none for the others; `Panel.ucf.d.ts` default-exports a Svelte `Component` with `heading: string`; a JS block's props are typed; an unparsable block keeps its declaration; removing a block deletes it.
  - edge cases: relative `root` and `outDir`; `outDir` as the root leaves `node_modules` alone; a `./Foo.svelte` import beside a `Foo/` folder; no `typescript` installed;
  - our language server: saves in one burst are one emit, a save after removing a block deletes its declaration, a multi-root workspace writes under the deepest folder, no tsdk means no emit, and no Svelte gives a warning;
  - real `svelte-language-server` 0.18.4 over LSP (`svelteserver --stdio`) on `src/App.svelte`: `TS2307` at each `.ucf` import before any emit; after our server's save and `didChangeWatchedFiles`, no diagnostic, hover on `<Panel` shows a `Component`, and an unsaved `heading={1}` is one `TS2322` at it;
  - real `svelte-check` 4.7.6 on the app: fails with `TS2307` on the `.ucf` imports before the emit, passes after it, and fails with one error at a wrong prop in `App.svelte`;
  - real tsserver with `typescript-svelte-plugin` 0.3.52 and our plugin both loaded, in either order, with the declarations present: `src/mountAll.ts` importing `App.svelte` and `Panel.ucf` gets Svelte's plugin's type for `App` and a `Component` for `Panel`, a wrong prop on either is one `TS2322`, definitions land in `App.svelte` and `Panel.ucf`;
  - the shared resolution set's `src/Gallery.svelte` row (5.9 left its tsserver side here): in `editor/imports.spec.ts`, real tsserver with `typescript-svelte-plugin` and our plugin, its import has no error, definition lands on `Card.ucf`, and the binding is a Svelte `Component`, as the build picks;
  - `editor/bundle.spec.ts`: the bundled server's save writes the same files, byte for byte, so svelte2tsx ran on the tsdk's TypeScript.
- Status: done

## Hands to later milestones

For milestone 6 (library build), which builds the Svelte package from these:

- The svelte row's `build(block, ctx)` in `packages/core/src/blocks/svelte.ts`: the `.svelte` code the Svelte package ships, once it can point imports at real files (the style ids, the class maps and the scope helper module `virtual:multifront/scope-attrs` of root forwarding).
- `loadSvelteCompiler(root)` in core, and `svelte` plus `@sveltejs/vite-plugin-svelte` as optional peers of `@multifront/vite`.
- `svelte2tsx` 0.7.61 as a pinned dependency of language-tools (its `emitDts` writes the package's `.d.ts`), and `renameSvelteStyles(block, split, compiler, modules)` in core, the rename the editor's script shares with `build()` (with its source map's `mappings`).
- The `<svelte>` blocks of the shared fixtures (`Counter.ucf`, `Panel.ucf`, `PanelItem.ucf`, `imports/Icon.ucf`), the model for the library fixture's Svelte blocks.
- `@sveltejs/kit` 2.70.3 and `@sveltejs/adapter-node` 5.5.7 as root devDependencies, and `startNodeServer(root)` (`build/index.js`) in `packages/e2e/build/lib/freshProcess.ts`, for 6.13's SvelteKit node server.

For milestone 7 (full editor support):

- `packages/language-tools/src/blocks/svelte.ts`: `types()` (`Card.ucf.svelte.ts`) for `mf-tsc` checking every target, and `editor()` for adding markup completions on top. `EditorOptions.svelteCompiler` and `svelteTypesRoot`.
- The source-map-to-Volar-mappings converter of 5.10, `sourceMapMappings(map, source, generated, data)` and `composeMappings(outer, inner)` in `packages/language-tools/src/mappings.ts`, for any other tool that gives a source map.
- `emitSvelteTypes({ root, outDir, ts, svelteTypesRoot })`, for `mf-tsc` to run it before `svelte-check` in CI.
- `startServer(options)` at `@multifront/language-tools/server` and its `ServerOptions` (`svelteTypesRoot`, `onTypeScript`), the hooks the VS Code bundle sets.
- `packages/core/src/blocks/svelte.ts` `build()`: the `.svelte` file `mf-lint` hands to oxlint; `mf-fmt` leaves `<svelte>` as written (spec 6.1).
- `loadSvelteCompiler(root)` in core.
- Diagnostic codes `svelte-parse-error` and `missing-style-module`.
- `svelteKind.check` reports `framework-in-block` (top-level scripts), as `vueKind.check` does.
- Fixtures: `components/Panel.ucf`, `components/PanelItem.ucf`, `components/svelte/{errors,shapes,imports,roots}/`, apps `svelte-vite`, `sveltekit-src`, `all-targets`.

## Exit test

`packages/e2e/browser/svelte-exit.spec.ts`:

- `apps/all-targets` in dev and after a build: `Panel.ucf` renders as Vue, React and Svelte side by side, the computed styles of the key elements are equal in all three, and the `data-v-*` value is the same.
- An edit to the `<svelte>` block hot-updates without a reload while the React counter keeps its state.
- Scope forwarding is the same in every framework: `Panel.ucf`'s scoped rule reaches `PanelItem`'s root as Vue, React and Svelte (5.8), with equal computed styles.

## Risks and open questions

- **`$style` is renamed under the hood.** Hover shows `__ucfStyle`. The other way was a store: `import style from …` and the class map wrapped as `{ subscribe }`, so `$style` works natively. Rejected because it takes the name `style`, which many Svelte components use for a prop.
- **plugin-svelte's `hotUpdate` transforms the bare file id.** Solved in 5.5 by wrapping that handler, like its compile `transform` in 5.3: both rely on plugin-svelte's plugin names (`vite-plugin-svelte:compile`, `vite-plugin-svelte:hot-update`) and on its hot update transforming the changed file first, unchanged from 7.0.0 to 7.3.0. The `svelte-floor` job runs the HMR test on 7.0.0.
- **Svelte names the component `Card_ucf_svelte`** (from the id's file name, `Card.ucf.svelte.svelte`). Only dev messages show it.
- **Svelte 5 HMR resets local state** on a block edit. The tests check "no reload", not "state kept".
- **The fallback declarations need `rootDirs`.** That setting also changes plain `tsc` for `.ts` importers in that project; our plugin and `mf-tsc` override it. Open: write them from the Vite dev server too, so CI without the editor has them?
- **Forwarding is runes-mode only.** Legacy components would need `$$restProps`. Runes mode is read from the block, as Svelte does without its compiler option: core cannot see plugin-svelte's `compilerOptions.runes`, so a project that forces runes there still needs one rune in a block (any `$props()`) for it to forward. A block with no rune and no legacy syntax (markup only) gets no edit, and no warning either: `$props()` would make it runes, `$$props` would break it in a runes project.
- **Svelte escapes a plain-text attribute twice beside a spread** in its server render (5.57.0). Forwarded roots work around it (5.8); a fixed Svelte release makes the workaround a no-op.
- **A forwarded `<img>` (or other load-event) root gets `onload` / `onerror="this.__e=event"`** in the server HTML: Svelte adds them to any element with a spread, to replay those events on hydration. A strict CSP without inline handlers blocks them, as for any Svelte spread.
- Names now aligned: the class map id is M1's `classMapId()`, the multi-root warning reuses M3's dev-only `__ucfWarnFragment` helper, the fuzz harness is M3's with M1's env vars.

## Out of scope

- Markup completions in `<svelte>` (tags, attributes, component props): milestone 7.
- `mf-tsc`, `mf-lint`, `mf-fmt` for Svelte blocks: milestone 7. oxfmt does not format Svelte yet.
- `v-bind()` in CSS for Svelte (open question in the spec).
- Svelte 4 and legacy-mode root forwarding.
- Svelte's own `<style>` scoping, and target-only `<style>` in a block (spec open question).
- Custom elements (`<svelte:options customElement>`).
- The Svelte library package and the SvelteKit consumer: milestone 6.
