# Milestone 6: Library build

## Goal

One command turns a folder of `.ucf` files into one npm package per framework. A consumer installs `@acme/ui-react`, `@acme/ui-vue` or `@acme/ui-svelte` like any other package: no multifront tooling, no plugin, no `.ucf` files.

It comes after the three targets (M3, M4, M5), so the per-target table is designed once, for React, Vue and Svelte together.

```bash
pnpm exec mf-build          # reads multifront.config.ts, writes dist/react, dist/vue and dist/svelte
```

```ts
// multifront.config.ts
import {defineLibrary} from '@multifront/vite';
export default defineLibrary({
  packages: {react: {name: '@acme/ui-react'}, vue: {name: '@acme/ui-vue'}, svelte: {name: '@acme/ui-svelte'}},
});
```

What comes out, per target:

```
dist/react/
  package.json        name, version, exports, types, sideEffects, peerDependencies only
  index.js  index.d.ts
  Card.js   Card.d.ts  Card.css  Card.js.map
  Counter.js          starts with "use client"
  styles.css          every component's CSS in one file
  _virtual/...        the small shared helpers (scope attributes, root props)
```

Svelte ships source, the way `svelte-package` does: `dist/svelte/Card.svelte` (uncompiled), `Card.svelte.d.ts`, `Card.css`, `styles.css`, `index.js`. The consumer's own Svelte compiler builds it.

Decisions this milestone makes:

- **Where:** `buildLibrary(options)` and `defineLibrary(options)` in `@multifront/vite`, plus the `mf-build` bin in the same package. It runs one real `vite build` per target with `multifront({framework: target, frameworks: [target]})` and that target's framework plugin. Svelte is the exception (below).
- **One target, one row.** A small table, `libraryTargets`, holds what differs per target: the framework plugin, the default peer ranges, extra export conditions, how output and types are made. React and Vue get rows in 6.1, Svelte in 6.8. Svelte's row ships uncompiled `.svelte` files instead of a compiled JS build, through an optional `emit(job)` hook; the react and vue rows keep the default Vite build.
- **One JS file per component:** every `.ucf` file with a block for the target is an entry, and Rolldown keeps modules as files (`preserveModules`). `src/forms/Field.ucf` becomes `forms/Field.js`.
- **CSS as real files.** Each component JS starts with `import "./Card.css"`. A combined `styles.css` sits beside them. `"sideEffects": ["*.css"]`.
- **`"use client"`:** core decides per `<react>` block (hooks, event handlers, an explicit directive). The plugin re-adds the directive at the top of that output file.
- **Types:** each target uses its framework's own standard tool on real files. We write a staged copy of `src/` where each `.ucf` file is replaced by its per-target types file (React: the `Card.ucf.react.tsx` script from language-tools, written as `Card.tsx`; Vue: the SFC code of the `<vue>` row, written as `Card.vue`). Then real `tsc` (React) or real `vue-tsc` (Vue) emits the `.d.ts` files. Svelte: `svelte2tsx`'s `emitDts` (what `svelte-package` uses) over the emitted `.svelte` files.
- **React conventions:** the root of every React component merges `className` and `style` from props and forwards `ref` (React 19, `ref` is a prop). The same transform runs in apps and in the library, so the two never differ.
- **tsdown and `vp pack` are not used and not supported** in this milestone. Our plugin needs Vite's CSS pipeline (preprocessors, CSS modules on `lang.css` ids) and composes `@vitejs/plugin-vue` and `@vitejs/plugin-react`, which are Vite plugins with Vite only hooks. tsdown runs Rolldown plugins and only some Vite plugins. `vp build` is plain Vite, so the app side already works there. See "Risks and open questions".

## Needs from earlier milestones

From M1:

- `splitBlocks(source, filename)` in `@multifront/core`.
- The `BlockKind` registry (`packages/core/src/blocks/index.ts`), exported from `@multifront/core`, and `VirtualFile` from core's `types.ts`.
- `compileStyles(blocks, {id, filename})` and `scopeId(relativePath, source, production)` in core.
- The private `packages/e2e` package: its `vitest.config.ts` (registered in the root `vitest.config.ts`), the `fixtures/`, `build/` and `browser/` folders, and Playwright with Chromium usable from it.

From M2:

- The `@multifront/language-tools` package.
- `getTypesScript(filename, source, target, options?: EditorOptions)` from `@multifront/language-tools` (`EditorOptions = {compiler?: VueCompiler}`; pass `{compiler: loadVueCompiler(root)}` from core, or only plain CSS modules are typed): the `Card.ucf.react.tsx` script of one file, with `$style` typed inside it and `.ucf` import specifiers left as written so we can rewrite them.
- The editor area harness in `packages/e2e/editor/` that runs real tsserver with `@multifront/language-tools/typescript-plugin` over a fixture file and returns its diagnostics.

From M3:

- `resolveTarget(importer, attribute, options)` in core, where a build entry (no importer) resolves to the `framework` option (M3 3.3).
- `multifront({frameworks, target, importers})` returning the pre plugin and the post attribute plugin.
- The module ids of spec 4.3: `/abs/Card.ucf.react.tsx` and `/abs/Card.ucf?ucf&type=style&index=N&lang.css`, and the `$style` class map module.
- The scope transform in core (oxc-parser + MagicString) with root forwarding, and the virtual helper module holding `__ucfScopeAttrs`, served by the Vite plugin.
- `@vitejs/plugin-react` as a peer (and pinned devDependency) of `@multifront/vite`.

From M4:

- The Vue target with the real `Card.ucf` id, `.ucf` in plugin-vue's `include`, and `features.componentIdGenerator` set to `scopeId`.
- The vue row's `build(block, ctx)` returning the SFC code (`<vue>` content plus the root `<style>` blocks) as a `VirtualFile` with ext `.vue`, callable from outside the Vite plugin.
- `buildTarget(split, ctx, target): VirtualFile` from `@multifront/core` (M3; throws `DiagnosticsError` on the file's errors), with `createBuildContext` (M1): the vue row's `build()` gives the SFC code.

From M5:

- The svelte row's `build(block, ctx)`: a `VirtualFile` with ext `.svelte` (`$style` renamed to `__ucfStyle`, scope stamps, root forwarding through `__ucfScopeAttrs`, no `<style>`).
- `loadSvelteCompiler(root)` in core; `svelte` and `@sveltejs/vite-plugin-svelte` as optional peers (and pinned devDependencies) of `@multifront/vite`.
- `svelte2tsx` 0.7.61, a pinned dependency of `@multifront/language-tools`.
- The pins M5 checked: `svelte` 5.57.0, `@sveltejs/kit` 2.70.3, `@sveltejs/adapter-node` 5.5.7, `svelte-check` 4.7.6.

New tools this milestone adds (exact pins, each older than 30 days, per `pnpm-workspace.yaml`):

- `@multifront/vite` devDependencies for its new optional peers: `typescript`, `vue-tsc`, `@multifront/language-tools` (`workspace:*`).
- Root devDependencies (AGENTS.md keeps test tools at the root): `publint`, `@arethetypeswrong/cli`. `next` is pinned only in the consumer app template; `react`, `react-dom`, their types and `vue` are already root devDependencies (M2, M3, M1).

## Steps

### 6.1 `buildLibrary()`: one JS file per component, per target

- Build:
  - `packages/vite/src/library/build.ts`: `buildLibrary(options): Promise<LibraryResult[]>` and `defineLibrary(options)`, exported from `@multifront/vite`. Types in `packages/vite/src/types.ts`:

    ```ts
    interface LibraryOptions {
      root?: string;           // library folder, default process.cwd()
      src?: string;            // default 'src'
      index?: string | false;  // default 'src/index.ts' when it exists
      outDir?: string;         // default 'dist'; each target writes <outDir>/<target>/
      frameworks?: Target[];   // default: every framework with a row and at least one block
      packages?: Partial<Record<Target, {name?: string; peers?: Record<string, string>}>>;
      vite?: InlineConfig;     // merged into every target's build (extra plugins, css options)
      dts?: boolean;           // default true, used from 6.6
    }
    interface LibraryResult {target: Target; outDir: string; packageName: string; files: string[]; skipped: string[]}
    ```

  - `packages/vite/src/library/targets.ts`: the `libraryTargets` table (`satisfies Partial<Record<Target, LibraryTarget>>`, the `LibraryTarget` interface in `packages/vite/src/types.ts`) with `react` (plugin-react, peers `react` and `react-dom` at `^19.0.0`) and `vue` (plugin-vue, peer `vue` at `^3.5.0`). A target with no row is a clear build error naming the target (Svelte until 6.8).
  - Per target: find every `.ucf` file under `src` with a block for that target (split once with `splitBlocks`). Files without that block are skipped and listed in `skipped`. Then run one real `vite build` with `configFile: false`, `mode: 'production'` (and `NODE_ENV=production` for the build, which Vite reads for `isProduction`), `publicDir: false`, `build.lib` (ES only, `cssFileName: 'styles'` until 6.2), `minify: false`, `sourcemap: true`, `emptyOutDir`, and `preserveModules` with `preserveModulesRoot` set to `src`.
  - A naming function, `outputName(id, src)` in `packages/vite/src/library/names.ts`, maps every `.ucf` module id (the bare one, `Card.ucf.react.tsx`, `Card.ucf.svelte.svelte`) to its path without `.ucf`: `Card.js`, `forms/Field.js`. Virtual modules go under `_virtual/`: `\0` ids (`_virtual/multifront/scope-attrs.js`, `_virtual/plugin-vue/export-helper.js`) and a `.ucf` file's sub-modules, named by their query (`_virtual/Card.module-0.js` for a class map, ours or plugin-vue's; `_virtual/Card.script.js` for plugin-vue's script).
  - The target's peers are external (a peer and its subpaths, like `react/jsx-runtime`). Any other bare import is a build error: the package has peer dependencies only. A file outside `src`, a given `index` that does not exist, an explicit framework no file has a block for, nothing to build, a `package.json` with no name (and no `packages[target].name`) or that does not parse, and two modules given one output name are build errors too. The default `index` is `index.ts` in `src`.
  - New fixture: `packages/e2e/fixtures/library/`, a small real library (not a workspace package; it resolves its tools from `packages/e2e/node_modules`). `package.json` (`@mf-fixture/ui`), `README.md`, `LICENSE`, `src/index.ts` and these components:
    - `Card.ucf`: React, Vue and Svelte, `<style module>` with CSS variables, `<style scoped lang="scss">`, imports `Icon.ucf`. No hooks.
    - `Icon.ucf`: React, Vue and Svelte, scoped style.
    - `Counter.ucf`: React (`useState`, `onClick`), Vue and Svelte (`$state`).
    - `Button.ucf`: React, Vue and Svelte, a `<button>` root with a module class and an `onClick` from props.
    - `Badge.ucf`: React and Vue; its React block reads `className` from props itself.
    - `Panel.ucf`: React, Vue and Svelte, no hooks, renders `Counter`.
    - `Tooltip.ucf`: React, Vue and Svelte (so `src/index.ts` can export it); its React block starts with `'use client'`, no hooks.
    - `forms/Field.ucf`: React, Vue and Svelte, nested folder.
    - `VueOnly.ucf`: only a `<vue>` block.
    - `hooks/useToggle.ts` (used by `Counter`) and `utils/cx.ts` (used by `Card` and `Button`): plain files.
- Deliverable: `buildLibrary({root, outDir})` writes `dist/react/` and `dist/vue/` with one JS file per component and one per plain module. The `<svelte>` blocks wait for 6.8.
- Test: build area, `packages/e2e/build/library.spec.ts`. Every library test builds the fixture library into its own fresh temp `outDir`, so tests can run in parallel. Check:
  - `react/Card.js`, `react/forms/Field.js`, `vue/VueOnly.js` exist; `react/VueOnly.js` does not and `skipped` names it.
  - no output file name or import specifier contains `.ucf`; `react/Card.js` imports `./Icon.js`.
  - `react/` contains no Vue or Svelte code and `vue/` no React or Svelte code (no `react` import in vue output, no `vue` import in react output, no `svelte` import in either).
  - `react` is imported, never bundled; a fixture copy that adds `import x from 'left-pad'` fails with the peer-only error.
  - the source map of `react/Card.js` maps a line of the JSX back into `Card.ucf`, using the real `source-map-js` reader.
  - each build error above, on its own fixture copy.
- Status: done

### 6.2 CSS as real files, plus `styles.css`

- Build: in `packages/vite/src/library/css.ts`, a plugin (`libraryCss`) added only to library builds.
  - Its `config` hook sets `build.cssCodeSplit: true`. Vite's per-chunk CSS naming does not hold up under `preserveModules` (one CSS file per `<style>` block, named after its chunk), so the plugin takes the fallback: it groups Vite's per-block CSS by `.ucf` file and emits one `Card.css` next to `Card.js`, blocks in source order, deleting Vite's per-block files. `build.lib.cssFileName` is gone.
  - In a late `renderChunk`, it prepends `import "./Card.css";` to the component chunk with MagicString, so the source map stays right. Which components have CSS comes from the module graph (a `.ucf` style id Vite's CSS step compiles), since `chunk.viteMetadata.importedCss` of the component chunk is only filled in `generateBundle`.
  - In `generateBundle`, emit `styles.css`: every component CSS file, ordered dependencies first (`Icon.css` before `Card.css`), the same order every run.
  - Build errors: a component written as `styles.css` (`src/styles.ucf`), and a plain `.css` file imported from code (a library package ships CSS from `.ucf` `<style>` blocks only).
- Deliverable: every component with styles ships `Name.css`, imported by its own JS; `styles.css` holds all of them.
- Test: build area, `packages/e2e/build/library-css.spec.ts`, on the fixture library:
  - `react/Card.js` and `vue/Card.js` import `./Card.css`; components without styles import no CSS.
  - `Card.css` has the `[data-v-<scopeId>]` selector, with the id from core's `scopeId()` for `src/Card.ucf`, and the compiled SCSS (no `&` left).
  - `styles.css` equals the component CSS files joined in dependency order. Two builds give byte-identical CSS.
  - no JS file injects CSS at runtime (no `document.createElement('style')`, no `__vite__updateStyle`).
  - each build error on its own fixture copy. 6.1's source map case of `react/Card.js` catches the one-line shift.
- Status: done

### 6.3 `"use client"` per output file

- Build:
  - Core, `packages/core/src/react/useClient.ts`: `needsUseClient(code, filename): boolean`, exported from `@multifront/core`. True when the `<react>` block has a `'use client'` directive, calls a hook (`useX(...)` or `React.useX(...)`, but not React 19's `use()`), has an `on[A-Z]*` JSX attribute that is not a string, calls `createContext`, or defines a class component. Uses oxc-parser.
  - Vite: the React target `load` records the answer per module id in builds (module meta `multifront.useClient`). A library-only `renderChunk` (`packages/vite/src/library/useClient.ts`, added for rows with `useClient: true`, the react row) puts `"use client";` as the first line of that chunk (never twice), before the CSS import. A plain `.ts` / `.tsx` module that had the directive keeps it the same way. Rolldown logs no "directive ignored" warning for these modules (it drops a directive that is not first silently), so there is nothing to silence; the test asserts the build logs no warning.
- Deliverable: `react/Counter.js`, `react/Button.js` and `react/Tooltip.js` start with `"use client"`; `Card.js`, `Panel.js`, `hooks/useToggle.js` do not.
- Test: build area, `packages/e2e/build/library-use-client.spec.ts`: builds the fixture library and reads the first statement of each output file with oxc-parser. Also checks the source map of `Counter.js` still points the right lines into `Counter.ucf` after the shift. The real proof that Next.js accepts it is 6.12.
- Status: done

### 6.4 React root props: `className`, `style`, `ref`

- Build: in core's scope transform (`packages/core/src/react/rootProps.ts`, called by `transformScope`), on every returned root of the default-exported component (same roots as the scope forward of M3):
  - `className={own}` (or `className="own"`) becomes `className={__ucfClass(own, __props.className)}`; no `className` gets `className={__props.className}`, added right after the forwarding spread, before every author attribute.
  - `style` the same with `__ucfStyle(own, __props.style)` (props win).
  - `ref`: no own ref gets `ref={__props.ref}`; an own ref gets `ref={__ucfRef(own, __props.ref)}` (one callback ref per pair, setting both, with React 19 cleanups).
  - Skipped when the component handles that prop itself: the author wins. It does when the destructured first parameter has the key, when it reads `props.className` / `props?.className` / `props['className']` (also through `props!` or `props as Props`, never below an inner `props` binding), when it destructures `props` with the key anywhere, and for `ref` inside `forwardRef`. A root spreading `props` or such a pattern's rest gets none of the three. An own prop with no value, or a string `style` / `ref`, is left alone. A `className` string with a line break or `\` is merged as a JS string; one with an entity is left unmerged. A helper name the block already uses is imported under a fresh one. No `mf-lint` rule: the rule is syntactic and stated in spec 3.5, item 5. Fragment roots get nothing, like the scope forward.
  - `__ucfClass`, `__ucfStyle`, `__ucfRef` go in the same virtual helper module as `__ucfScopeAttrs`, in dev and production, so they ship once per package under `_virtual/`.
- Deliverable: `<Button className="extra" style={{color: 'red'}} ref={buttonRef} />` renders one `<button>` with both classes, the merged style (its own `font-weight: 600`, added to the fixture's three blocks, plus the parent's color), and `buttonRef.current` set to it. Same in apps and in the library.
- Test:
  - Core, `packages/core/test/react/scope.spec.ts`: a table over `packages/e2e/fixtures/components/react/root-props/` (one detection rule or edge per fixture, rows of the forwarding `SHAPES` table), what each root's `className` / `style` / `ref` becomes, dev and production; no `ref` on `forwardRef` roots.
  - Build area: `library.spec.ts` checks `react/Button.js` imports the merges from `_virtual/multifront/scope-attrs.js`, the only file defining them; the scope fuzz's "only adds" rule knows the new inserts.
  - Browser area, `packages/e2e/browser/react-root-props.spec.ts`, with a new fixture app `packages/e2e/fixtures/apps/react-root-props/` that imports `Button.ucf` and `Badge.ucf` from the library fixture and `react/root-props/Own.ucf` (own className, style and ref). Real Vite build, served, Playwright: class list, computed `color`, `padding` (the parent's wins) and `font-weight`, `ref` element tag names written into the page by the app, both refs set on `Own`, the parent's callback ref attached once over two renders and its own cleanup run when `Own` unmounts. Plus `react-dom/server` `renderToString` of the same App through the dev server's SSR runner, hydrated in the dev page (React checks attribute mismatches only in dev) with no node replaced and no console warning. `Badge` shows its `className` once (author wins).
- Status: done

### 6.5 Root props in the React types

- Build: in `packages/language-tools/src/blocks/react.ts`, the `Card.ucf.react.tsx` types script types the default export with the root props added: `className?: string`, `style?: CSSProperties`, `ref?: Ref<...>`. The ref type comes from the root tag (`<button>` gives `HTMLButtonElement`, through `React.ComponentRef<'button'>`), a union for several roots, `Element` when unknown. Skipped the same way as 6.4 when the component handles the prop itself.
  - Core: `reactRootProps(block, filename): ReactRootProps | undefined` and `propsTypeInserts(site, type)`, exported from `@multifront/core` (types `ReactRootProps`, `ReactRoot`, `ReactPropsSite`, `RootProp` in core's `types.ts`). The same analysis as 6.4's transform: each element root with the root props it takes, and where the props type is written (the first parameter's annotation, a `memo` / `forwardRef` type argument, or after the `(` when there is no parameter). A parameter with no annotation keeps its own type.
  - Language-tools writes `& {className?: …}` there (parenthesizing a union or function type), the content mapped 1:1 in pieces around it.
- Deliverable: the editor accepts `<Button className="x" ref={buttonRef} />` and rejects a wrong ref type, matching what 6.4 does at runtime.
- Test:
  - Editor area, `packages/e2e/editor/react-root-props.spec.ts`: real tsserver with the TypeScript plugin over `fixtures/apps/react-root-props/src/App.tsx` (new `tsconfig.json`). No diagnostics on the valid uses; a `// @ts-expect-error` line with `ref` typed for a `<div>` is the only error and is consumed. A table of unsaved probe lines checks the shapes (wrappers, no parameter, a union props type in the new `react/root-props/UnionProps.ucf`, a `memo` type argument in the new `react/root-props/MemoTyped.ucf`, author-handled props).
  - Core, `packages/core/test/react/scope.spec.ts`: on every `SHAPES` row, `reactRootProps` gives the roots and props the build output shows.
- Status: done

### 6.6 `.d.ts` per target

- Build: `packages/vite/src/library/types.ts`, called by `buildLibrary` after each JS build when `dts` is on. Each row's `emitTypes(job)` (`LibraryTypesJob` in `packages/vite/src/types.ts`: `target`, `root`, `src`, `outDir`, and `modules`, the `.ucf` files and plain modules the JS build wrote):
  - Stage a copy of `src/` in a fresh folder under the library's own `node_modules/.cache/multifront/` (so `@types/react` and `vue` resolve from the library), deleted after.
  - React: each `.ucf` becomes `Card.tsx` with the code of `getTypesScript(filename, source, 'react', {compiler})`, `compiler` from `loadVueCompiler(root)`. Every `.ucf` specifier (in the staged `.tsx` and in plain `.ts` files like `index.ts`) becomes `./Card.js`. Then real `tsc` with a generated tsconfig: extends the library's `tsconfig.json` when present (else `es2022`, `esnext`, `bundler`, `strict`, `skipLibCheck`), `declaration`, `emitDeclarationOnly`, `jsx: react-jsx`, no declaration maps, `outDir` and `declarationDir` set to `dist/react`, `include: []`.
  - The tool runs twice. tsc writes no `.d.ts` for a file under `node_modules` that it only reaches by import, so a first `--listFilesOnly` run (roots: the staged `modules` and the `.d.ts` files of `src`) lists every staged file the program reaches, a type-only import included. The real run takes all of them as roots (`files`).
  - Vue: each `.ucf` becomes `Card.vue` with the code of `buildTarget(split, ctx, 'vue')`. `.ucf` specifiers become `./Card.vue`. Real `vue-tsc` with the same settings. Then rename `Card.vue.d.ts` to `Card.d.ts` and rewrite `./Card.vue` to `./Card.js` in every `.d.ts`.
  - Specifier rewrites use oxc (Vite's `parseAst`) and MagicString, never a regex. A type error in a block fails the build with the `.ucf` file name (`src/Card.ucf: error TS2322: …`; a plain file keeps its position).
  - `typescript` (`^6.0.0`), `vue-tsc` (`^3.3.11`) and `@multifront/language-tools` are optional peers of `@multifront/vite`, loaded only here. A missing one is an error that names the package to install (or `dts: false`).
- Deliverable: every JS file in `dist/react` and `dist/vue` outside `_virtual/` has a `.d.ts` beside it, with no `.ucf`, `.tsx` or `.vue` specifier left. `_virtual/` holds internal helpers no `.d.ts` imports and no export reaches: they get none.
- Test: build area, `packages/e2e/build/library-types.spec.ts`. Builds the fixture library, then runs real `tsc --noEmit` (React) and real `vue-tsc --noEmit` (Vue) over two check files in `packages/e2e/fixtures/library-checks/` (`react.tsx`, `Check.vue`), copied beside the built folders so they import them by relative path: right props pass, `<Card titel="x" />` sits under `// @ts-expect-error` (React) or `<!-- @vue-expect-error -->` (Vue), `Button`'s `ref` is `HTMLButtonElement` (a `<div>` ref fails), a wrong `click` payload fails in Vue. Fails if any `.d.ts` is missing or wrong. Also: a type error in a `<react>` or `<vue>` block names `src/Card.ucf`; a type-only module gets its `.d.ts` (the listing run); the library's `tsconfig.json` is extended with the emit options forced; `dts: false` writes none.
- Status: done

### 6.7 Each target's `package.json`, and packing

- Build: `packages/vite/src/library/packageJson.ts`, called last for each target:
  - `name` (from `packages[target].name`, default `<name>-<target>`), `version`, `description`, `license`, `author`, `repository`, `homepage`, `keywords` copied from the library's `package.json`. `type: "module"`. `sideEffects: ["*.css"]`.
  - `exports`: `"."` (when there is an index), one subpath per component (`"./Card"`, `"./forms/Field"`), each `{types, default}`; `"./styles.css"`, `"./*.css"`, `"./package.json"`. A row may add conditions (Svelte needs `svelte`).
  - `peerDependencies` from the row, overridable in `packages[target].peers`. No `dependencies`, no `devDependencies`, no `scripts`.
  - `README.md` and `LICENSE` copied when present.
- Deliverable: `dist/react` and `dist/vue` are ready to `pnpm pack`.
- Test: consumer area, `packages/e2e/consumer/pack.spec.ts`. Starts the consumer area folder and its helper `packages/e2e/consumer/lib/pack.ts` with `packLibrary(outDir): Promise<Record<Target, string>>` (real `pnpm pack --pack-destination`, one tarball per target). Checks the tarball file list (`tar -t`): JS, `.d.ts`, CSS, `styles.css`, `package.json`, `README.md`, `LICENSE`, no `.ucf`, no `node_modules`. Runs real `publint` and real `attw --pack --profile esm-only` on each tarball; both must pass.

### 6.8 The Svelte package

- Build: the `svelte` row of `libraryTargets`, with peer `svelte` (`^5.0.0`), the extra export condition `svelte`, and an `emit(job)` hook (the react and vue rows keep the default Vite build). Then `libraryTargets` changes from `satisfies Partial<Record<Target, LibraryTarget>>` to `Record<Target, LibraryTarget>`, so a target without a library row no longer compiles.
  - This step adds `library: boolean` to M1's `BuildContextOptions` and `BuildContext`, so the svelte row's `build()` points imports at real relative files instead of virtual ids.
  - Per component, in `dist/svelte/`: `Panel.svelte` from `build()` in library mode (the class map inlined as `const __ucfStyle = {…}`, `import './Panel.css'`, `.ucf` imports rewritten to `./Counter.svelte`, the forward helper shipped once as `_ucf/scopeAttrs.js`); `Panel.css` and the combined `styles.css` from 6.2's CSS step; `Panel.svelte.d.ts` from `svelte2tsx`'s `emitDts` over the emitted files; `index.js` and `index.d.ts` re-exporting every component.
  - `package.json` through 6.7's writer: `exports` with `types` and `svelte` conditions, `"svelte": "./index.js"`, peer `svelte` ^5, no dependencies, `"sideEffects": ["*.css"]`. No `"use client"` step.
- Deliverable: `dist/svelte/` that follows the `svelte-package` layout.
- Test: build area, `packages/e2e/build/svelte-library.spec.ts`, on the fixture library: the file list; every `.svelte` file compiles with the real Svelte compiler with no reference to a `.ucf` file or a virtual id; `tsc` over `index.d.ts` with the svelte shims passes; `package.json` has no `dependencies`; the tarball from 6.7's `packLibrary` passes `publint`.

### 6.9 The `mf-build` command and `multifront.config.ts`

- Build: `packages/vite/src/library/cli.ts` and a `bin` entry `mf-build` in `packages/vite/package.json`. It loads `multifront.config.ts` (or `.js`, `.mjs`) from the root through Vite's config loader, merges flags (`--root`, `--framework` repeatable, `--out-dir`, `--no-dts`), calls `buildLibrary` and prints one line per target with its file count and skipped files. Exit code 1 on any error. `docs/plan.md` gains the API and the command; spec 8 names `mf-build`.
- Deliverable: `pnpm exec mf-build` in a library folder builds every target.
- Test: build area, `packages/e2e/build/library-cli.spec.ts`. Adds `multifront.config.ts` to the library fixture (package names `@mf-fixture/ui-react`, `@mf-fixture/ui-vue`, `@mf-fixture/ui-svelte`). Runs the real bin as a child process into a temp out dir and checks the written `package.json` names. `--framework vue` builds Vue only. A config naming an unknown target exits 1 with the message.

### 6.10 Consumer: a fresh Vite React app

- Build:
  - `packages/e2e/consumer/lib/app.ts`: `createConsumerApp(template, tarballs)` copies a template app to a new folder in the OS temp dir (outside the workspace), writes its own `pnpm-workspace.yaml` with the repo's install policy (exact pins, `minimumReleaseAge`, `ignoreScripts`), runs `pnpm install`, then `pnpm add <tarball>`. Also `runInApp(app, command)`, `serveApp(app, command, port)` and `openPage(url)` returning the page plus every console message and page error.
  - `MULTIFRONT_KEEP_CONSUMER_APPS` (dev): keep the temp apps for debugging. Registered in `scripts/lib/env.mjs`.
  - Template `packages/e2e/fixtures/apps/consumer-vite-react/`: exact pinned `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `typescript`, `@types/react`. No multifront package. `index.html` sets a strict CSP (`style-src 'self'`). `App.tsx` renders `Card`, `Counter`, `Button` (with `className`, `style`, `ref`) from `@mf-fixture/ui-react`. A second entry `only-card.tsx` imports only `Card`.
- Deliverable: the packed React package installs and works in a plain Vite React app.
- Test: consumer area, `packages/e2e/consumer/vite-react.spec.ts`: build the fixture library, pack, install. Real `tsc --noEmit` in the app passes (with one `// @ts-expect-error` on a wrong prop). Real `vite build`, then `vite preview` and Playwright: Card's computed padding and color come from the library CSS, Counter increments on click, Button has both classes and its ref is a `BUTTON`. No console error or warning, no CSP violation. The `only-card` bundle holds no Counter code and no Counter CSS (sideEffects works).

### 6.11 Consumer: a fresh Vite Vue app

- Build: template `packages/e2e/fixtures/apps/consumer-vite-vue/` (exact pinned `vite`, `@vitejs/plugin-vue`, `vue`, `vue-tsc`, `typescript`), `App.vue` renders `Card`, `Counter`, `Button`, `VueOnly` from `@mf-fixture/ui-vue`; one page imports `@mf-fixture/ui-vue/styles.css` instead of relying on per-component CSS.
- Deliverable: the packed Vue package installs and works in a plain Vite Vue app.
- Test: consumer area, `packages/e2e/consumer/vite-vue.spec.ts`: real `vue-tsc --noEmit` passes (one `<!-- @vue-expect-error -->` on a wrong prop), real `vite build`, `vite preview`, Playwright: styles applied, Counter increments, the `data-v-<scopeId>` attribute on Card's root equals the React one from 6.10, no console error or warning.

### 6.12 Consumer: a fresh Next.js App Router app

- Build: template `packages/e2e/fixtures/apps/consumer-next/` (exact pinned `next`, `react`, `react-dom`, `typescript`, `@types/react`). `app/page.tsx` is a server component (no directive) that renders `Card`, `Panel` (which renders `Counter`), `Button` and `Tooltip` from `@mf-fixture/ui-react`, plus one from a subpath (`@mf-fixture/ui-react/forms/Field`).
- Deliverable: the packed React package works in Next.js App Router with server rendering and React Server Components.
- Test: consumer area, `packages/e2e/consumer/next.spec.ts`:
  - real `next build` passes. Without the directive on `Counter.js` it would fail ("useState only works in Client Components"), so this proves 6.3.
  - `next start` and Playwright: with JavaScript turned off the page is already styled (the CSS is a real `<link>`, server rendered); with JavaScript on, Counter increments inside the server-rendered `Panel`.
  - no console error, warning or page error: no hydration text, and none of React's minified hydration errors (`#418`, `#423`, `#425`).
  - the same page under `next dev` shows no hydration warning either (full warning texts in dev).

### 6.13 Consumer: a fresh SvelteKit app

- Build: template `packages/e2e/fixtures/apps/consumer-sveltekit/` (SvelteKit 2.70.3, adapter-node, `svelte-check`, nothing from multifront). A route renders `Card`, `Counter`, `Button` from `@mf-fixture/ui-svelte`.
- Deliverable: the packed Svelte package works in a fresh SvelteKit app.
- Test: consumer area, `packages/e2e/consumer/sveltekit.spec.ts`: pack the library, install the tarball, run `svelte-check` (passes; a page with a wrong prop fails), `vite build`, start the node server, then Playwright: the SSR HTML has the `data-v-*` elements, the CSS loads as a file, hydration logs no warning, a click works, and the computed styles of key elements equal 6.10's Vite React consumer.

## Hands to later milestones

- `buildLibrary(options)`, `defineLibrary(options)`, `LibraryOptions`, `LibraryResult` from `@multifront/vite`, and the `mf-build` bin.
- `libraryTargets` (a full `Record<Target, LibraryTarget>`) in `packages/vite/src/library/targets.ts`, and `LibraryTarget` in `packages/vite/src/types.ts`.
- The shared library steps every row reuses: CSS per component and `styles.css` (`css.ts`), `"use client"` handling, the staged types tree (`types.ts`, through each row's `emitTypes(job)` with `LibraryTypesJob`), `package.json` writing (`packageJson.ts`).
- `needsUseClient(code, filename)` and `reactRootProps(block, filename)` from `@multifront/core`. M7 may use the first for an editor hint; the second places the root props in `Card.ucf.react.tsx`.
- `__ucfClass`, `__ucfStyle`, `__ucfRef` in the React helper module, and the root props in `Card.ucf.react.tsx`. M7's `mf-tsc` sees the same props as the shipped `.d.ts`.
- The library fixture `packages/e2e/fixtures/library/` and its `multifront.config.ts`. M7 runs `mf-tsc` and `mf-lint` over it.
- The consumer area `packages/e2e/consumer/` with `packLibrary`, `createConsumerApp`, `runInApp`, `serveApp`, `openPage`. M7 packs `@multifront/language-tools` with it.

## Exit test

Consumer area, `packages/e2e/consumer/exit.spec.ts`, from a clean copy of the library fixture:

1. Run the real `mf-build` bin.
2. `packLibrary()`: one tarball per target, each passing `publint` and `attw`.
3. `createConsumerApp()` four times, fresh: `consumer-next`, `consumer-vite-react`, `consumer-vite-vue`, `consumer-sveltekit`.
4. In each app: the real type check (`tsc`, `vue-tsc` or `svelte-check`), the real production build (`next build`, `vite build`), the real server (`next start`, `vite preview`, the SvelteKit node server).
5. Playwright on each page: Card, Counter, Button render; Counter increments; no console error or warning, no page error, no hydration error in Next or SvelteKit.
6. Visual parity: the computed `padding`, `color`, `border-radius` and `font-size` of Card's root and title are the same in all four apps, and Card's `data-v-*` attribute is the same.

It passes only if JS per component, the uncompiled Svelte files, CSS files, `"use client"`, `.d.ts`, `package.json` and the React root props all work in real installs.

## Risks and open questions

- **Rolldown and `preserveModules`.** Ids with a query (`?ucf&type=style&…`), ids with a double extension (`Card.ucf.react.tsx`) and `\0` virtual ids must map to clean file names, and the CSS of a style id must land in the component's CSS file. 6.1 and 6.2 prove it early; the fallback is our own CSS emit (6.2).
- **Directives.** Rolldown may keep or drop `"use client"`; we add it only when missing. Turbopack (Next's default bundler) and webpack must both accept CSS imported from a `"use client"` file in `node_modules`. 6.12 covers the default; a webpack run (`next build --webpack`) is cheap to add if it breaks.
- **`"use client"` detection is a heuristic.** A hook reached in an unusual way (`React['useState']`) is missed. The author adds `'use client'` in the block; it is always kept.
- **Automatic `className` / `style` / `ref` merge** (decided: automatic, spec 8). It changes what a React root gets, in apps too. Decided in 6.4: a syntactic rule (destructured key, `props.x` read, destructuring of `props`, a root spread of `props` or its rest, `ref` in `forwardRef`), no `mf-lint` rule. `props` passed on whole is not detected; the root still gets the props.
- **React 18.** Root `ref` forwarding needs React 19 (`ref` as a prop), so the peer range is `^19.0.0` (decided). A `forwardRef` wrapper for React 18 can be added later if users ask.
- **`vue-tsc` and TypeScript 6.** Settled in 6.6: `vue-tsc` 3.3.11 (peer `typescript >=5.0.0`, the same version as the `@vue/language-core` language-tools pins) runs on TypeScript 6.0.3, so there is no second TypeScript pin.
- **The staged types tree** mirrors `src/`. Path aliases into `src` in the library's `tsconfig.json` point at the real `src/`, outside the stage, so they are not supported yet. Aliases defined only in Vite config do not reach `tsc` either. The listing run makes the types step about one `tsc` start slower per target.
- **Svelte's `emit(job)` hook.** If the svelte row's `.svelte` output can be a normal Vite build after all, the hook goes away and all three rows share one path.
- **Index per target.** One `src/index.ts` serves every target, so it may only re-export components that have every target's block. Open: allow `index.react.ts` style per-target index files?
- **Consumer tests are slow and need the npm registry.** Installs use exact pins but transitive versions float; a shared pnpm store in CI keeps them fast. If they get too slow for every `pnpm devx test`, the consumer area becomes its own CI job.
- **tsdown / `vp pack`.** Not recommended now: they run Rolldown plugins, not Vite's CSS pipeline, and plugin-vue / plugin-react need Vite hooks. Supporting them would mean a second, Vite-free path for CSS and Vue. Open: revisit once this milestone ships if tsdown's Vite plugin support and CSS handling cover what we need; then the test is the fixture library built under `vp pack` and run through the same consumer apps.

## Out of scope

- tsdown and `vp pack` support.
- Publishing to npm, version bumps and release flow.
- CommonJS or UMD output, minified output.
- Bundling third-party runtime dependencies into a target package.
- `"use server"` and server actions.
- Nuxt, Remix and other consumer frameworks.
- `v-bind()` in CSS for React.
