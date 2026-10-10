# Implementation plan

How we build [the spec](spec.md). How the pieces fit: [architecture.md](architecture.md).

## Packages

| Package | Job | When |
| --- | --- | --- |
| `@multifront/core` | Bundler agnostic: block splitter, style compile, scope ids, the target rules of spec 4.1 and 4.2, per-target transforms. Never imports Vite. | exists |
| `@multifront/vite` | The Vite plugin. Hands each target to plugin-vue, plugin-react or plugin-svelte, and rewrites import attributes. | exists |
| `@multifront/language-tools` | Everything that checks `.ucf` files without building them: the Volar language plugin (per-target virtual scripts), the TypeScript plugin (`./typescript-plugin`), the language server (`./server`), and the `mf-tsc`, `mf-lint` and `mf-fmt` commands. | exists |
| `packages/vscode` | The VS Code extension (Marketplace and Open VSX, not npm). Bundles `language-tools`; the one package not built by plain `tsc`. | exists |
| `packages/e2e` | Private, never published or built: the cross-package e2e tests, one folder per area, and the shared fixtures. | milestone 1 |

`@multifront/vite` also gets the library build (milestone 5): it is one Vite build per target, so it needs the plugin anyway.

**Why this split.** Packages follow who installs them and why. A package is added only when its milestone starts and needs it:

- `core` is only ever a dependency of the others; nobody installs it directly.
- `vite` is what an author adds to build: the plugin and the library build.
- `language-tools` is what an author adds to check: types, lint, format, the editor. The TypeScript plugin and the server are subpaths, not packages, so other editors (WebStorm, Neovim) can load them from the same install.
- `vscode` stays apart because it ships through a different store, not npm.

## Prototype first

Three unknowns can change the design. Each gets a throwaway spike before its milestone starts:

1. **Types by import attribute.** A tsserver plugin whose `resolveModuleNameLiterals` reads `with { framework }` from the import and resolves `./Card.ucf` to a per-target virtual script. If tsserver does not hand us the import node, fall back to the importer's framework and the default target only, and drop per-import overrides from the types (the build still honours them).

   **Answers** (milestone 2.1, run on TypeScript 6.0.3, `@volar/typescript` 2.4.28, Node 26.11.1, VS Code 1.141.0 whose tsserver runs on Electron's Node 24.21.0):

   1. **Yes, the import node is there.** Inside `resolveModuleNameLiterals`, `literal.parent` is the `ImportDeclaration`, the `ExportDeclaration` or the `import()` `CallExpression`, and `with { framework }` reads from it in all three. Only that one parent link is set at that point: pass the source file to `getStart()` / `getText()`. Per-import attributes stay in the types.
   2. **Expected limit: one resolution per (specifier, mode).** In one file, `./Card.ucf` with `react` then with `vue`: the plugin is asked for both and answers both, but the program keeps the last answer for both imports. Decision: one framework per specifier per file, in types only. The plugin warns on the second import and names the fix: one small re-export file per framework.
   3. **No.** Volar's tsserver plugin path never serves `getExtraServiceScripts`: it logs `getExtraServiceScripts() is not available in TS plugin.`, and an import resolved to `/abs/Card.ucf.react.tsx` is `TS2307`. Decision: in M2 the `.ucf` file's main service script is the React code, and React imports resolve to `/abs/Card.ucf` itself. Milestone 4 must solve per-target scripts before it adds Vue.
   4. **Yes, ESM loads, on two conditions.** tsserver loads a plugin with `require()`, so ESM works through `require(esm)` on Node 26 and inside VS Code. But tsserver skips a module that is not a function: the entry must export its factory as `'module.exports'` (`export default` alone is skipped). tsserver also finds the plugin with its own Node10 lookup, which ignores `exports`: `@multifront/language-tools/typescript-plugin` must be a real `typescript-plugin/` folder. An `index.js` there that imports the package's own `./typescript-plugin` export works, and Node applies `--conditions=source` to that import when the package is a workspace link. No bundled `.cjs` needed.
   5. **Yes.** No diagnostic on `framework` under `module: preserve` or `module: nodenext`, for static imports, `export ... from` and `import()`. Control: `module: es2020` gives TS's own `TS2823` / `TS1324` for any attribute, whatever the key.
   6. **Yes, hybrid mode works.** With `"languages": ["ucf"]`, VS Code sends `Card.ucf` to tsserver (`updateOpen`), and our plugin serves completion, hover and definition inside `<react>`. Rename and references cross `Card.ucf` and `App.tsx`. An unsaved prop rename in `Card.ucf` is a `TS2322` in `App.tsx` at once, in VS Code and over tsserver's `change` command.

   Cases 2.9 takes over (the spike script ran each one over tsserver's stdio protocol):

   - `main.ts`, `reexport.ts`, `lazy.ts`: the framework of each import kind reaches the resolver;
   - `mixed.ts`: both imports get the last import's file;
   - `App.tsx`: `quickinfo` on `<Card` shows `{ title: string }`; `definition` lands in `Card.ucf` inside `<react>`;
   - no diagnostic on the attribute under `module: preserve` and `module: nodenext`;
   - `Card.ucf` opened in tsserver: `completionInfo` and `quickinfo` inside `<react>`; `rename` on the prop lists `App.tsx`; `references` from `App.tsx` lists the use in `<react>`;
   - a `change` renaming the prop in `Card.ucf`, no save: `App.tsx` reports the old prop.
2. **A `<vue>` block in the editor.** Generate Vue virtual code from the block with `@vue/language-core` and map its offsets back into the `.ucf` file.
3. **Attributes surviving each compiler.** Check plugin-vue's script compile, the Svelte compiler and Oxc all keep `with { ... }` on imports, so our post rewrite still sees it.

## Building on plugin-vue

We **compose** `@vitejs/plugin-vue`, never fork it. It is a peer dependency of `@multifront/vite`, and our plugin runs before it (`enforce: 'pre'`) so it only ever sees plain SFC code. What we learned reading plugin-vue 6.0.8:

1. **Borrow its compiler.** plugin-vue exposes `api.options.compiler`, filled in its `buildStart`. `getVueCompiler()` reads it, and falls back to core's `loadVueCompiler(root)`, which resolves `vue/compiler-sfc` from the project root the same way plugin-vue does (the editor uses it too). Done and tested.
2. **The `vue` query is taken.** plugin-vue treats any id with a `vue` query as one of its own sub-requests (`Card.vue?vue&type=style`). Our internal ids use `?target=react` / `?target=svelte` instead (spec 4.3). Users never write a query; they use import attributes.
3. **No virtual `.vue` path.** On a cache miss (a dev server restart, SSR) plugin-vue reads the SFC from disk with `fs.readFileSync`, which fails for a file that does not exist. So the Vue target keeps the real `Card.ucf` path as the module id: we add `/\.ucf$/` to plugin-vue's `include` (its `api.include` setter, from our `configResolved`) and turn the `.ucf` source into SFC code in our pre `transform`. This is the pattern unplugin-vue-markdown uses with `.md` files. A test must cover the restart and SSR cache misses.
4. **One scope id for all targets.** plugin-vue hashes `sha256(relativePath + (production ? source : ''))`, first 8 hex chars. It also takes `features.componentIdGenerator`, so we set our own generator there and use the same one for React and Svelte. Same `data-v-*` everywhere, by construction.

## Framework versions

- Our packages share one version (`version.json`), our own semver. It never copies a framework's number: one plugin serves three frameworks, and our fixes need numbers of their own. plugin-vue and plugin-react do the same.
- We never ship or run a framework compiler of our own. Vue: we borrow plugin-vue's. React: we hand plain `.tsx` to the user's plugin-react. So the user's versions are always the ones in use.
- Each framework and its Vite plugin is an optional peer range of `@multifront/vite`. React: `^19.0.0`. Vue and Svelte ranges come with their milestones.
- The framework API names our transforms look for live in one file per framework (`packages/core/src/react/reactApis.ts`). A new framework version edits that file only.
- CI tests each range at both ends: the pinned devDependencies (top) and `pnpm devx peer-floor <framework>` (bottom).
- A new framework major joins the range in a minor release of ours. Dropping one is a major release of ours.

## Milestones

Each milestone has a detailed document with ordered steps, deliverables and tests in [milestones/](milestones/README.md). Where it and the summary below differ, the milestone document wins.

### 1. Splitter, block kinds + styles

- The `BlockKind` contract and the registry in core ([architecture.md](architecture.md)), with `<style>` as the first full kind. Every later milestone fills in one row.
- `splitBlocks(source, filename)` in core: a hand-written scanner for top-level `<vue>`, `<react>`, `<svelte>`, `<style ...>`. Content is raw text up to the first matching closing tag.
- Errors carry `{code, message, line, column}`. The splitter: `duplicate-target`, `unknown-root-tag`, `unclosed-block`, `missing-target`, `text-outside-block`. `checkBlocks(split)` adds each kind's `check`: `react-no-default-export`, `style-inside-target`, `unknown-style-lang`, `duplicate-style-module`.
- `compileStyles(blocks, {id, filename})`: `compileStyleAsync` once per `<style>`, returns CSS, map and the CSS-module class map.
- `scopeId(relativePath, source, production)`: the plugin-vue scheme above.
- Tests: splitter fixtures (`<>`, `<T,>`, `a < b`, `</react>` inside a string, duplicates, unclosed) and style snapshots (scoped, module, named module, scss).

### 2. Editor basics

- `packages/vscode`: `.ucf` language id, file icon, TextMate grammar embedding the Vue, TSX, Svelte and CSS / SCSS grammars. Highlighting in every block from day one.
- `language-tools`, the Volar language plugin: Embedded code for `<react>` (TSX) and `<style>` (CSS / SCSS), plus the `Card.ucf.react.tsx` virtual script with `$style` typed from the class names. A `.ucf` import inside the block resolves to the other file's React virtual script automatically.
- `language-tools/typescript-plugin`: `.ts` / `.tsx` files importing `.ucf` get the React types, using `resolveTarget()` from core (spike 1).
- `language-tools/server`: completions, errors, hover and go to definition inside `<style>` (CSS, SCSS), and our own diagnostics on the whole `.ucf` file. Inside `<react>` they come from tsserver with our plugin (hybrid mode).
- Tests: snapshots of the virtual code and its offset mapping; a tsserver test that a `.tsx` importer sees the right props.

### 3. React target and imports (go / no-go)

- `resolveTarget(importer, attribute, options)` in core: the spec 4.1 and 4.2 rules (automatic inside a block, attribute or importer outside), shared by the Vite plugin and the TypeScript plugin.
- Vite: resolve `.ucf` imports to the per-target ids of spec 4.3; a post plugin moves `with { framework }` into the id and removes it (static, re-export and dynamic imports; a non-literal value is an error).
- Virtual modules: style CSS, class map, and `Card.ucf?target=react&lang.tsx`.
- Scope transform in core (oxc-parser + MagicString): stamp host and component elements, forward on returned roots (several returns, `?:`, `&&`, `memo`, `forwardRef`), rewrite destructured props, warn on fragment roots. The forwarding helper is a virtual module served by the Vite plugin, not a package.
- Tests: snapshot per JSX shape; a block importing another `.ucf` gets its own framework, and an attribute inside a block is an error; every outside rule and its order; no attribute left in dev, build or SSR output.
- Exit check: demo app renders the React Card; Fast Refresh keeps state; a style edit only reloads CSS; a parent scoped style reaches a child root.
- `react`, `react-dom` and plugin-react as optional peers; every React test also runs at the bottom of their range (`react-floor` CI job).
- If the scope transform is not reliable, fall back to CSS modules only for React and revisit.

### 4. Vue target

- The composition described above: real `.ucf` id, plugin-vue `include`, shared `componentIdGenerator`.
- Editor: the `<vue>` block through `@vue/language-core` (spike 2), and `Card.ucf.vue.ts` for `.vue` importers.
- Tests: dev, build, SSR, a cache miss after restart, and one app importing the same file as React and Vue.

### 5. Library build

- In `@multifront/vite`: one Vite library build per target with `framework` set, one JS file per component, real CSS files plus a combined `styles.css`.
- `"use client"` re-added per output file when the component uses hooks or event handlers.
- Types: `.d.ts` per target from the per-target virtual scripts. Writes each target's `package.json` with exports, types and peer deps only.
- Exit check: the packed React build works in a fresh Next.js App Router app and a fresh Vite React app.

### 6. Svelte target

- `Card.ucf?target=svelte&lang.svelte` with the `$style` import, stamping via `svelte/compiler` `parse`, no Svelte `<style>`.
- Editor: `Card.ucf.svelte.ts` through `svelte2tsx`, for `.svelte` importers and the `<svelte>` block's types.
- Library output: uncompiled `.svelte` files + processed CSS + `.d.ts`.

### 7. Full editor support

- `mf-tsc` over every target, Svelte markup completions.
- oxfmt and oxlint for `.ucf` (spec 6.1): `mf-fmt` through oxfmt's `format()` API, block by block; `mf-lint` through temporary per-block files and oxlint's JSON output, while proposing `.ucf` support to oxc upstream. Both wired into the language server.

## Alongside every milestone

- HMR: style-only edits update only style modules; a target edit invalidates only that target.
- Visual parity test (Playwright) and SSR hydration test, once two targets exist.
- CI tests each framework peer range at both ends (see "Framework versions").

## Open questions

1. Target-only `<style>` inside a target block?
2. `v-bind()` in CSS for React / Svelte: drop, or CSS variables on the forwarded root?
3. Shared prop types: a root `<types lang="ts">` block?
4. Opt-out of scope attribute forwarding per component?
