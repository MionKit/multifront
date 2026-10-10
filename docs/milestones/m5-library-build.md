# Milestone 5: Library build

## Goal

One command turns a folder of `.ucf` files into one npm package per framework. A consumer installs `@acme/ui-react` or `@acme/ui-vue` like any other package: no multifront tooling, no plugin, no `.ucf` files.

```bash
pnpm exec mf-build          # reads multifront.config.ts, writes dist/react and dist/vue
```

```ts
// multifront.config.ts
import {defineLibrary} from '@multifront/vite';
export default defineLibrary({packages: {react: {name: '@acme/ui-react'}, vue: {name: '@acme/ui-vue'}}});
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

Decisions this milestone makes:

- **Where:** `buildLibrary(options)` and `defineLibrary(options)` in `@multifront/vite`, plus the `mf-build` bin in the same package. It runs one real `vite build` per target with `multifront({framework: target, frameworks: [target]})` and that target's framework plugin.
- **One target, one row.** A small table, `libraryTargets`, holds what differs per target: the framework plugin, the default peer ranges, how types are made. React and Vue get rows now. Svelte (M6) is one more row.
- **One JS file per component:** every `.ucf` file with a block for the target is an entry, and Rolldown keeps modules as files (`preserveModules`). `src/forms/Field.ucf` becomes `forms/Field.js`.
- **CSS as real files.** Each component JS starts with `import "./Card.css"`. A combined `styles.css` sits beside them. `"sideEffects": ["*.css"]`.
- **`"use client"`:** core decides per `<react>` block (hooks, event handlers, an explicit directive). The plugin re-adds the directive at the top of that output file.
- **Types:** each target uses its framework's own standard tool on real files. We write a staged copy of `src/` where each `.ucf` file is replaced by its per-target types file (React: the `Card.ucf.react.tsx` script from language-tools, written as `Card.tsx`; Vue: the SFC code of the `<vue>` row, written as `Card.vue`). Then real `tsc` (React) or real `vue-tsc` (Vue) emits the `.d.ts` files.
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
- The module ids of spec 4.3: `/abs/Card.ucf?target=react&lang.tsx` and `/abs/Card.ucf?ucf&type=style&index=N&lang.css`, and the `$style` class map module.
- The scope transform in core (oxc-parser + MagicString) with root forwarding, and the virtual helper module holding `__ucfScopeAttrs`, served by the Vite plugin.
- `@vitejs/plugin-react` as a peer (and pinned devDependency) of `@multifront/vite`.

From M4:

- The Vue target with the real `Card.ucf` id, `.ucf` in plugin-vue's `include`, and `features.componentIdGenerator` set to `scopeId`.
- The vue row's `build(block, ctx)` returning the SFC code (`<vue>` content plus the root `<style>` blocks) as a `VirtualFile` with ext `.vue`, callable from outside the Vite plugin.
- `buildTarget(split, ctx, target): VirtualFile` from `@multifront/core` (M3), with `createBuildContext` (M1): the vue row's `build()` gives the SFC code.

New tools this milestone adds (exact pins, each older than 30 days, per `pnpm-workspace.yaml`):

- `@multifront/vite` devDependencies for its new optional peers: `typescript`, `vue-tsc`, `@multifront/language-tools` (`workspace:*`).
- Root devDependencies (AGENTS.md keeps test tools at the root): `publint`, `@arethetypeswrong/cli`. `next` is pinned only in the consumer app template; `react`, `react-dom`, their types and `vue` are already root devDependencies (M2, M3, M1).

## Steps

### 5.1 `buildLibrary()`: one JS file per component, per target

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
      dts?: boolean;           // default true, used from 5.6
    }
    interface LibraryResult {target: Target; outDir: string; packageName: string; files: string[]; skipped: string[]}
    ```

  - `packages/vite/src/library/targets.ts`: the `LibraryTarget` interface and the `libraryTargets` table (`satisfies Partial<Record<Target, LibraryTarget>>`) with `react` (plugin-react, peers `react` and `react-dom` at `^19.0.0`) and `vue` (plugin-vue, peer `vue` at `^3.5.0`). A target with no row is a clear build error naming the target.
  - Per target: find every `.ucf` file under `src` with a block for that target (split once with `splitBlocks`). Files without that block are skipped and listed in `skipped`. Then run one real `vite build` with `configFile: false`, `mode: 'production'`, `build.lib` (ES only), `minify: false`, `sourcemap: true`, `emptyOutDir`, and `preserveModules` with `preserveModulesRoot` set to `src`.
  - A naming function maps every `.ucf` module id (with or without the `?target=` query) to its path without `.ucf`: `Card.js`, `forms/Field.js`. Virtual modules go under `_virtual/`.
  - The target's peers are external (a peer and its subpaths, like `react/jsx-runtime`). Any other bare import is a build error: the package has peer dependencies only.
  - New fixture: `packages/e2e/fixtures/library/`, a small real library (not a workspace package; it resolves its tools from `packages/e2e/node_modules`). `package.json` (`@mf-fixture/ui`), `README.md`, `LICENSE`, `src/index.ts` and these components:
    - `Card.ucf`: React and Vue, `<style module>` with CSS variables, `<style scoped lang="scss">`, imports `Icon.ucf`. No hooks.
    - `Icon.ucf`: React and Vue, scoped style.
    - `Counter.ucf`: React (`useState`, `onClick`) and Vue.
    - `Button.ucf`: React and Vue, a `<button>` root with a module class and an `onClick` from props.
    - `Badge.ucf`: React and Vue; its React block reads `className` from props itself.
    - `Panel.ucf`: React and Vue, no hooks, renders `Counter`.
    - `Tooltip.ucf`: React block starts with `'use client'`, no hooks.
    - `forms/Field.ucf`: React and Vue, nested folder.
    - `VueOnly.ucf`: only a `<vue>` block.
    - `hooks/useToggle.ts` (used by `Counter`) and `utils/cx.ts` (used by `Card` and `Button`): plain files.
- Deliverable: `buildLibrary({root, outDir})` writes `dist/react/` and `dist/vue/` with one JS file per component and one per plain module.
- Test: build area, `packages/e2e/build/library.spec.ts`. Every library test builds the fixture library into its own fresh temp `outDir`, so tests can run in parallel. Check:
  - `react/Card.js`, `react/forms/Field.js`, `vue/VueOnly.js` exist; `react/VueOnly.js` does not and `skipped` names it.
  - no output file name or import specifier contains `.ucf` or `?target=`; `react/Card.js` imports `./Icon.js`.
  - `react/` contains no Vue code and `vue/` no React code (no `react` import in vue output, no `vue` import in react output).
  - `react` is imported, never bundled; a fixture copy that adds `import x from 'left-pad'` fails with the peer-only error.
  - the source map of `react/Card.js` maps a line of the JSX back into `Card.ucf`, using the real `source-map-js` reader.

### 5.2 CSS as real files, plus `styles.css`

- Build: in `packages/vite/src/library/css.ts`, a plugin added only to library builds.
  - `build.cssCodeSplit: true` and asset names so each component's CSS is `Card.css` next to `Card.js`.
  - In a late `renderChunk` (after Vite's CSS step filled `chunk.viteMetadata.importedCss`), prepend `import "./Card.css";` to the chunk with MagicString, so the source map stays right.
  - In `generateBundle`, emit `styles.css`: every component CSS file, ordered dependencies first (`Icon.css` before `Card.css`), the same order every run.
  - If Vite's per-chunk CSS naming does not hold up under `preserveModules`, the plugin collects the compiled CSS of the style ids itself and emits one file per component. The test is the same either way.
- Deliverable: every component with styles ships `Name.css`, imported by its own JS; `styles.css` holds all of them.
- Test: build area, `packages/e2e/build/library-css.spec.ts`, on the fixture library:
  - `react/Card.js` and `vue/Card.js` import `./Card.css`; components without styles import no CSS.
  - `Card.css` has the `[data-v-<scopeId>]` selector, with the id from core's `scopeId()` for `src/Card.ucf`, and the compiled SCSS (no `&` left).
  - `styles.css` equals the component CSS files joined in dependency order. Two builds give byte-identical CSS.
  - no JS file injects CSS at runtime (no `document.createElement('style')`, no `__vite__updateStyle`).

### 5.3 `"use client"` per output file

- Build:
  - Core, `packages/core/src/react/useClient.ts`: `needsUseClient(code, filename): boolean`, exported from `@multifront/core`. True when the `<react>` block has a `'use client'` directive, calls a hook (`useX(...)` or `React.useX(...)`, but not React 19's `use()`), has an `on[A-Z]*` JSX attribute that is not a string, calls `createContext`, or defines a class component. Uses oxc-parser.
  - Vite: the React target `load` records the answer per module id. A library-only `renderChunk` puts `"use client";` as the first line of that chunk (never twice), before the CSS import. A plain `.ts` / `.tsx` module that had the directive keeps it the same way. The bundler's "directive ignored" warning is silenced for these modules only.
- Deliverable: `react/Counter.js`, `react/Button.js` and `react/Tooltip.js` start with `"use client"`; `Card.js`, `Panel.js`, `hooks/useToggle.js` do not.
- Test: build area, `packages/e2e/build/library-use-client.spec.ts`: builds the fixture library and reads the first statement of each output file with oxc-parser. Also checks the source map of `Counter.js` still points the right lines into `Counter.ucf` after the shift. The real proof that Next.js accepts it is 5.11.

### 5.4 React root props: `className`, `style`, `ref`

- Build: in core's scope transform, on every returned root of the default-exported component (same roots as the scope forward of M3):
  - `className={own}` becomes `className={__ucfClass(own, __props.className)}`; no `className` gets `className={__props.className}`.
  - `style` the same with `__ucfStyle(own, __props.style)` (props win).
  - `ref`: no own ref gets `ref={__props.ref}`; an own ref gets `ref={__ucfRef(own, __props.ref)}`.
  - Skipped when the component handles that prop itself: the author wins. The detection rule (destructuring, `props.className`, a spread on the root, or something smarter, plus any `mf-lint` rule) is designed in this step's todo. Fragment roots get nothing, like the scope forward.
  - `__ucfClass`, `__ucfStyle`, `__ucfRef` go in the same virtual helper module as `__ucfScopeAttrs`, so they ship once per package under `_virtual/`.
- Deliverable: `<Button className="extra" style={{color: 'red'}} ref={buttonRef} />` renders one `<button>` with both classes, the merged style, and `buttonRef.current` set to it. Same in apps and in the library.
- Test: browser area, `packages/e2e/browser/react-root-props.spec.ts`, with a new fixture app `packages/e2e/fixtures/apps/react-root-props/` that imports `Button.ucf` and `Badge.ucf` from the library fixture. Real Vite build, served, Playwright: class list, computed `color`, `ref` element tag name written into the page by the app. Plus `react-dom/server` `renderToString` of the same App, hydrated in the page with no console warning. `Badge` shows its `className` once (author wins).

### 5.5 Root props in the React types

- Build: in `packages/language-tools/src/blocks/react.ts`, the `Card.ucf.react.tsx` types script types the default export with the root props added: `className?: string`, `style?: CSSProperties`, `ref?: Ref<...>`. The ref type comes from the root tag (`<button>` gives `HTMLButtonElement`, through `React.ComponentRef<'button'>`), a union for several roots, `Element` when unknown. Skipped the same way as 5.4 when the component handles the prop itself.
- Deliverable: the editor accepts `<Button className="x" ref={buttonRef} />` and rejects a wrong ref type, matching what 5.4 does at runtime.
- Test: editor area, `packages/e2e/editor/react-root-props.spec.ts`: real tsserver with the TypeScript plugin over `fixtures/apps/react-root-props/src/App.tsx`. No diagnostics on the valid uses; a `// @ts-expect-error` line with `ref` typed for a `<div>` is the only error and is consumed.

### 5.6 `.d.ts` per target

- Build: `packages/vite/src/library/types.ts`, called by `buildLibrary` after each JS build when `dts` is on. Each row's `emitTypes(job)`:
  - Stage a copy of `src/` in a fresh folder under the library's own `node_modules/.cache/multifront/` (so `@types/react` and `vue` resolve from the library), deleted after.
  - React: each `.ucf` becomes `Card.tsx` with the code of `getTypesScript(filename, source, 'react', {compiler})`, `compiler` from `loadVueCompiler(root)`. Every `.ucf` specifier (in the staged `.tsx` and in plain `.ts` files like `index.ts`) becomes `./Card.js`. Then real `tsc` with a generated tsconfig: extends the library's `tsconfig.json` when present, `declaration`, `emitDeclarationOnly`, `jsx: react-jsx`, no declaration maps, `files` set to the entries, `outDir` set to `dist/react`.
  - Vue: each `.ucf` becomes `Card.vue` with the code of `buildTarget(split, ctx, 'vue')`. `.ucf` specifiers become `./Card.vue`. Real `vue-tsc` with the same settings. Then rename `Card.vue.d.ts` to `Card.d.ts` and rewrite `./Card.vue` to `./Card.js` in every `.d.ts`.
  - Specifier rewrites use oxc-parser and MagicString, never a regex. A type error in a block fails the build with the `.ucf` file name.
  - `typescript`, `vue-tsc` and `@multifront/language-tools` are optional peers of `@multifront/vite`, loaded only here. A missing one is an error that names the package to install.
- Deliverable: every JS file in `dist/react` and `dist/vue` has a `.d.ts` beside it, with no `.ucf`, `.tsx` or `.vue` specifier left.
- Test: build area, `packages/e2e/build/library-types.spec.ts`. Builds the fixture library, then runs real `tsc --noEmit` (React) and real `vue-tsc --noEmit` (Vue) over two check files in `packages/e2e/fixtures/library-checks/` that import from the built folders by relative path: right props pass, `<Card titel="x" />` sits under `// @ts-expect-error` (React) or `<!-- @vue-expect-error -->` (Vue), `Button`'s `ref` is `HTMLButtonElement`. Fails if any `.d.ts` is missing or wrong.

### 5.7 Each target's `package.json`, and packing

- Build: `packages/vite/src/library/packageJson.ts`, called last for each target:
  - `name` (from `packages[target].name`, default `<name>-<target>`), `version`, `description`, `license`, `author`, `repository`, `homepage`, `keywords` copied from the library's `package.json`. `type: "module"`. `sideEffects: ["*.css"]`.
  - `exports`: `"."` (when there is an index), one subpath per component (`"./Card"`, `"./forms/Field"`), each `{types, default}`; `"./styles.css"`, `"./*.css"`, `"./package.json"`. A row may add conditions (Svelte needs `svelte`).
  - `peerDependencies` from the row, overridable in `packages[target].peers`. No `dependencies`, no `devDependencies`, no `scripts`.
  - `README.md` and `LICENSE` copied when present.
- Deliverable: `dist/react` and `dist/vue` are ready to `pnpm pack`.
- Test: consumer area, `packages/e2e/consumer/pack.spec.ts`. Starts the consumer area folder and its helper `packages/e2e/consumer/lib/pack.ts` with `packLibrary(outDir): Promise<Record<Target, string>>` (real `pnpm pack --pack-destination`, one tarball per target). Checks the tarball file list (`tar -t`): JS, `.d.ts`, CSS, `styles.css`, `package.json`, `README.md`, `LICENSE`, no `.ucf`, no `node_modules`. Runs real `publint` and real `attw --pack --profile esm-only` on each tarball; both must pass.

### 5.8 The `mf-build` command and `multifront.config.ts`

- Build: `packages/vite/src/library/cli.ts` and a `bin` entry `mf-build` in `packages/vite/package.json`. It loads `multifront.config.ts` (or `.js`, `.mjs`) from the root through Vite's config loader, merges flags (`--root`, `--framework` repeatable, `--out-dir`, `--no-dts`), calls `buildLibrary` and prints one line per target with its file count and skipped files. Exit code 1 on any error. `docs/plan.md` gains the API and the command; spec 8 names `mf-build`.
- Deliverable: `pnpm exec mf-build` in a library folder builds every target.
- Test: build area, `packages/e2e/build/library-cli.spec.ts`. Adds `multifront.config.ts` to the library fixture (package names `@mf-fixture/ui-react`, `@mf-fixture/ui-vue`). Runs the real bin as a child process into a temp out dir and checks the written `package.json` names. `--framework vue` builds Vue only. A config naming an unknown target exits 1 with the message.

### 5.9 Consumer: a fresh Vite React app

- Build:
  - `packages/e2e/consumer/lib/app.ts`: `createConsumerApp(template, tarballs)` copies a template app to a new folder in the OS temp dir (outside the workspace), writes its own `pnpm-workspace.yaml` with the repo's install policy (exact pins, `minimumReleaseAge`, `ignoreScripts`), runs `pnpm install`, then `pnpm add <tarball>`. Also `runInApp(app, command)`, `serveApp(app, command, port)` and `openPage(url)` returning the page plus every console message and page error.
  - `MULTIFRONT_KEEP_CONSUMER_APPS` (dev): keep the temp apps for debugging. Registered in `scripts/lib/env.mjs`.
  - Template `packages/e2e/fixtures/apps/consumer-vite-react/`: exact pinned `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `typescript`, `@types/react`. No multifront package. `index.html` sets a strict CSP (`style-src 'self'`). `App.tsx` renders `Card`, `Counter`, `Button` (with `className`, `style`, `ref`) from `@mf-fixture/ui-react`. A second entry `only-card.tsx` imports only `Card`.
- Deliverable: the packed React package installs and works in a plain Vite React app.
- Test: consumer area, `packages/e2e/consumer/vite-react.spec.ts`: build the fixture library, pack, install. Real `tsc --noEmit` in the app passes (with one `// @ts-expect-error` on a wrong prop). Real `vite build`, then `vite preview` and Playwright: Card's computed padding and color come from the library CSS, Counter increments on click, Button has both classes and its ref is a `BUTTON`. No console error or warning, no CSP violation. The `only-card` bundle holds no Counter code and no Counter CSS (sideEffects works).

### 5.10 Consumer: a fresh Vite Vue app

- Build: template `packages/e2e/fixtures/apps/consumer-vite-vue/` (exact pinned `vite`, `@vitejs/plugin-vue`, `vue`, `vue-tsc`, `typescript`), `App.vue` renders `Card`, `Counter`, `Button`, `VueOnly` from `@mf-fixture/ui-vue`; one page imports `@mf-fixture/ui-vue/styles.css` instead of relying on per-component CSS.
- Deliverable: the packed Vue package installs and works in a plain Vite Vue app.
- Test: consumer area, `packages/e2e/consumer/vite-vue.spec.ts`: real `vue-tsc --noEmit` passes (one `<!-- @vue-expect-error -->` on a wrong prop), real `vite build`, `vite preview`, Playwright: styles applied, Counter increments, the `data-v-<scopeId>` attribute on Card's root equals the React one from 5.9, no console error or warning.

### 5.11 Consumer: a fresh Next.js App Router app

- Build: template `packages/e2e/fixtures/apps/consumer-next/` (exact pinned `next`, `react`, `react-dom`, `typescript`, `@types/react`). `app/page.tsx` is a server component (no directive) that renders `Card`, `Panel` (which renders `Counter`), `Button` and `Tooltip` from `@mf-fixture/ui-react`, plus one from a subpath (`@mf-fixture/ui-react/forms/Field`).
- Deliverable: the packed React package works in Next.js App Router with server rendering and React Server Components.
- Test: consumer area, `packages/e2e/consumer/next.spec.ts`:
  - real `next build` passes. Without the directive on `Counter.js` it would fail ("useState only works in Client Components"), so this proves 5.3.
  - `next start` and Playwright: with JavaScript turned off the page is already styled (the CSS is a real `<link>`, server rendered); with JavaScript on, Counter increments inside the server-rendered `Panel`.
  - no console error, warning or page error: no hydration text, and none of React's minified hydration errors (`#418`, `#423`, `#425`).
  - the same page under `next dev` shows no hydration warning either (full warning texts in dev).

## Hands to later milestones

- `buildLibrary(options)`, `defineLibrary(options)`, `LibraryOptions`, `LibraryResult` from `@multifront/vite`, and the `mf-build` bin. M6 builds the Svelte package through them.
- `LibraryTarget` and `libraryTargets` in `packages/vite/src/library/targets.ts`. **What M6 plugs in:** a `svelte` row with
  - peers `svelte` (`^5.0.0`) and the extra export condition `svelte`;
  - its emit: uncompiled `.svelte` files from the svelte row's `build()` (svelte-package convention), with the `$style` map and the CSS import as plain files; if this cannot be a normal compile, M6 adds an optional `emit(job)` hook to `LibraryTarget`, and the react and vue rows keep the default Vite build;
  - its `emitTypes(job)` through `svelte2tsx`'s `emitDts` over the staged tree of 5.6;
  - then `libraryTargets` changes from `satisfies Partial<Record<Target, LibraryTarget>>` to `Record<Target, LibraryTarget>`, so a target without a library row no longer compiles.
- The shared library steps every row reuses: CSS per component and `styles.css` (`css.ts`), `"use client"` handling, the staged types tree (`types.ts`), `package.json` writing (`packageJson.ts`). M6 uses all but `"use client"`.
- `needsUseClient(code, filename)` from `@multifront/core`. M7 may use it for an editor hint.
- `__ucfClass`, `__ucfStyle`, `__ucfRef` in the React helper module, and the root props in `Card.ucf.react.tsx`. M7's `mf-tsc` sees the same props as the shipped `.d.ts`.
- The library fixture `packages/e2e/fixtures/library/` and its `multifront.config.ts`. M6 adds a `<svelte>` block to its components and `svelte` to the config; M7 runs `mf-tsc` and `mf-lint` over it.
- The consumer area `packages/e2e/consumer/` with `packLibrary`, `createConsumerApp`, `runInApp`, `serveApp`, `openPage`. M6 adds the template `packages/e2e/fixtures/apps/consumer-sveltekit/` and `packages/e2e/consumer/sveltekit.spec.ts`, and adds SvelteKit to the exit parity check.

## Exit test

Consumer area, `packages/e2e/consumer/exit.spec.ts`, from a clean copy of the library fixture:

1. Run the real `mf-build` bin.
2. `packLibrary()`: one tarball per target, each passing `publint` and `attw`.
3. `createConsumerApp()` three times, fresh: `consumer-next`, `consumer-vite-react`, `consumer-vite-vue`.
4. In each app: the real type check (`tsc` or `vue-tsc`), the real production build (`next build`, `vite build`), the real server (`next start`, `vite preview`).
5. Playwright on each page: Card, Counter, Button render; Counter increments; no console error or warning, no page error, no hydration error in Next.
6. Visual parity: the computed `padding`, `color`, `border-radius` and `font-size` of Card's root and title are the same in all three apps, and Card's `data-v-*` attribute is the same.

It passes only if JS per component, CSS files, `"use client"`, `.d.ts`, `package.json` and the React root props all work in real installs.

## Risks and open questions

- **Rolldown and `preserveModules`.** Ids with a query (`?target=react&lang.tsx`) and `\0` virtual ids must map to clean file names, and the CSS of a style id must land in the component's CSS file. 5.1 and 5.2 prove it early; the fallback is our own CSS emit (5.2).
- **Directives.** Rolldown may keep or drop `"use client"`; we add it only when missing. Turbopack (Next's default bundler) and webpack must both accept CSS imported from a `"use client"` file in `node_modules`. 5.11 covers the default; a webpack run (`next build --webpack`) is cheap to add if it breaks.
- **`"use client"` detection is a heuristic.** A hook reached in an unusual way (`React['useState']`) is missed. The author adds `'use client'` in the block; it is always kept.
- **Automatic `className` / `style` / `ref` merge** (decided: automatic, spec 8). It changes what a React root gets, in apps too. How the compiler sees that a component handles a prop itself (destructuring, `props.className`, a spread, something smarter), and whether an `mf-lint` rule helps, is designed in this step's todo.
- **React 18.** Root `ref` forwarding needs React 19 (`ref` as a prop), so the peer range is `^19.0.0` (decided). A `forwardRef` wrapper for React 18 can be added later if users ask.
- **`vue-tsc` and TypeScript 6.** The repo pins TypeScript 6.0.3. If no `vue-tsc` release older than 30 days supports it, 5.6 pins the newest TypeScript `vue-tsc` supports for the Vue types step only.
- **The staged types tree** mirrors `src/`. Path aliases in the library's `tsconfig.json` still work (we extend it). Aliases defined only in Vite config do not reach `tsc`.
- **Index per target.** One `src/index.ts` serves every target, so it may only re-export components that have every target's block. Open: allow `index.react.ts` style per-target index files?
- **Consumer tests are slow and need the npm registry.** Installs use exact pins but transitive versions float; a shared pnpm store in CI keeps them fast. If they get too slow for every `pnpm devx test`, the consumer area becomes its own CI job.
- **tsdown / `vp pack`.** Not recommended now: they run Rolldown plugins, not Vite's CSS pipeline, and plugin-vue / plugin-react need Vite hooks. Supporting them would mean a second, Vite-free path for CSS and Vue. Open: revisit after M6 if tsdown's Vite plugin support and CSS handling cover what we need; then the test is the fixture library built under `vp pack` and run through the same consumer apps.

## Out of scope

- Svelte output and the SvelteKit consumer (M6).
- tsdown and `vp pack` support.
- Publishing to npm, version bumps and release flow.
- CommonJS or UMD output, minified output.
- Bundling third-party runtime dependencies into a target package.
- `"use server"` and server actions.
- Nuxt, Remix and other consumer frameworks.
- `v-bind()` in CSS for React.
