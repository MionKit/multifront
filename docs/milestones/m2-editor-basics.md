# Milestone 2: Editor basics

## Goal

Open a `.ucf` file in VS Code and get a real editor from day one:

- Highlighting in every block (`<react>`, `<vue>`, `<svelte>`, `<style>`), from a grammar generated from the block kind registry.
- Inside `<react>`: TypeScript completions, errors, hover and go to definition, with `$style` typed from the class names of `<style module>`.
- Inside `<style>`: CSS and SCSS completions, errors, hover and go to definition.
- Outside: a `.ts` or `.tsx` file that imports `./Card.ucf` gets the React component types, picked by the same `resolveTarget()` the build will use.

This is spec section 6 steps 1 to 3. Two new packages: `@multifront/language-tools` (npm) and `packages/vscode` (the extension, `multifront-vscode`).

## Needs from earlier milestones

From milestone 1, in `@multifront/core`:

- `splitBlocks(source: string, filename: string)`, returning the blocks it found **and** its errors without throwing, so a broken file still gets an editor. Each block is `{type, attrs, content, start, end, contentStart, contentEnd}`, with `attrs` holding `lang`, `module` (`true` or a name) and `scoped`. Each error is `{code, message, line, column}` with the codes `duplicate-target`, `unknown-root-tag`, `unclosed-block`, `missing-target`, `react-no-default-export`, `style-inside-target`. M2 also needs to know if `line` and `column` start at 0 or 1, and a span to underline (`start` / `end` offsets). If M1 has no offsets, step 2.6 adds `start` and `end` to the error type.
- `BlockKind`, `VirtualFile` (`{ext, code, map}`) and the `ctx` type, from `packages/core/src/types.ts`.
- The registry in `packages/core/src/blocks/index.ts`: one ordered array of `BlockKind`, shared rows first (called `blockKinds` here). M2 adds rows that only have `tag`, `role` and `grammar`, so the `check` and `build` operations must be allowed to be missing until their milestone fills them.
- The `style` row in `packages/core/src/blocks/style.ts` with `grammar: {scopeName}`. M2 needs one scope per `lang` (`css`, `scss`, `less`, `stylus`, `postcss`). If M1 only has one `scopeName`, step 2.2 adds `langScopes?: Record<string, string>` to the grammar shape.
- `VirtualFile.map` as offset segments that convert to Volar mappings with no loss: `{sourceOffsets: number[]; generatedOffsets: number[]; lengths: number[]}[]`. A v3 source map would lose the exact spans the editor needs.
- `compileStyles(blocks, {id, filename})` and its CSS-module class map per module name. M2 uses it in one test only, to prove the editor's class names match the build's.
- A way to load `@vue/compiler-sfc` from a project root with no Vite, the one `compileStyles` already uses (called `loadVueCompiler(root)` here). If it still lives only inside `@multifront/vite`'s `getVueCompiler`, step 2.5 moves the fallback lookup into core and the Vite plugin calls it.
- `Target`, `TARGETS`, `isTarget` (already in core today).

From milestone 1, in `packages/e2e`:

- The private package, its Vitest project in the root `vitest.config.ts`, and `fixtures/components/`.
- The splitter fixtures (TSX edge cases: `<>`, `<T,>`, `a < b`, `</react>` in a string, duplicates, unclosed) and the style fixtures (scoped, module, named module, scss). M2 reads them, never edits them.

## Steps

### 2.1 Spike: types by import attribute (throwaway)

Spike 1 of [plan.md](../plan.md) "Prototype first". The code is thrown away; only the answers stay.

- Build: a scratch tsserver plugin (not merged) loaded into the real tsserver of TypeScript 6.0.3, plus one `.ucf` file and a few importers. It answers five questions:
  1. Inside `resolveModuleNameLiterals`, can we reach the import node of each literal (`literal.parent`, or by walking `containingSourceFile.statements` when parents are not set yet) and read `with { framework: 'react' }` on static imports, `export ... from` and `import('./Card.ucf', { with: { framework: 'react' } })`?
  2. Two imports of the same specifier with different frameworks in one file: does TypeScript keep two resolutions, or one per (specifier, mode)? We expect one.
  3. Can `./Card.ucf` resolve to a file that is not on disk, `/abs/Card.ucf.react.tsx`, served as a Volar extra service script (`getExtraServiceScripts`), and do hover and definition map back to the `.ucf` file?
  4. Does tsserver load an ESM plugin (`require(esm)`) under Node 26 and inside the pinned VS Code, or must the plugin ship as one CJS file?
  5. Does TypeScript accept the `framework` key with no error under `module: preserve` and `module: nodenext`?
- Deliverable: the answers written into plan.md, spike 1, plus the decision for each "no":
  - **No to 1:** types follow the importer's framework and the default target only. Per-import attributes are dropped from types (the build still honours them). The TypeScript plugin then adds a warning on any attribute that picks another framework than the types use: "types follow react here, the build uses vue". It can read the attribute in `getSemanticDiagnostics`, where the full tree is there. Spec section 5 and the imports fixture set (2.7) mark attribute rows as "build only".
  - **Expected limit on 2:** one framework per specifier per file in types. The plugin warns on the second import and points to the fix: a small re-export file per framework.
  - **No to 3:** the `.ucf` file's main service script is the React code in M2, and milestone 4 must solve per-target scripts before adding Vue.
  - **No to 4:** the `./typescript-plugin` subpath ships one bundled `.cjs` file, the one exception to "ESM only".
- Test: the spike's own script runs the real tsserver over its stdio protocol and prints the file each import resolves to. Its cases become the tsserver tests of 2.9.

### 2.2 Grammar from the registry

- Build:
  - In core, `packages/core/src/blocks/react.ts`, `vue.ts`, `svelte.ts`: rows with `tag`, `role: 'target'` and `grammar` only (`source.tsx`, `source.ucf.vue`, `source.ucf.svelte`). M3, M4 and M6 fill in the rest.
  - The `style` row gets one scope per `lang`: `css` → `source.css`, `scss` → `source.css.scss`, `less` → `source.css.less`, `stylus` → `source.stylus`, `postcss` → `source.css`.
  - New folder `packages/vscode`, package `multifront-vscode`, private. `src/grammar.ts` exports `generateGrammar(kinds = blockKinds)`. It writes `source.ucf`: one begin/end rule per tag (`(<)(react)\b[^>]*(>)` to `(</)(react)(>)`, matching the splitter: the first closing tag ends the block), with `contentName: meta.embedded.block.<tag>` and an include of the row's scope. Style gets one rule per `lang` (a lookahead on the `lang` attribute), plus a plain CSS default.
  - Pinned copies of the Vue grammar (and its injection grammars: directives, interpolations, style variable injection) and the Svelte grammar, both MIT, in `packages/vscode/syntaxes/vendor/` with their licenses and `sources.json` (upstream repo and commit). `generateGrammar` renames their root scopes to `source.ucf.vue` and `source.ucf.svelte`, so they never clash with the official Vue or Svelte extension. Token scopes stay the same, so themes colour them the same.
  - `packages/vscode` exports `./grammar` (with the `source` condition) so the e2e package can import it.
- Deliverable: `generateGrammar()` returns the full grammar set (ours plus the renamed vendored copies) from the registry. A new row in the registry gets highlighting with no grammar edit.
- Test: area **Editor**, `packages/e2e/editor/grammar.spec.ts`, helper `packages/e2e/editor/lib/tokenize.ts` (`tokenizeUcf(path)`). It loads `generateGrammar()` into the real `vscode-textmate` with `vscode-oniguruma`; the grammars VS Code ships built in (`source.tsx`, `source.css`, `source.css.scss`, `text.html.basic`, ...) come from the pinned `tm-grammars` package. For every M1 splitter fixture that splits with no error and every new M2 fixture:
  - every character between `contentStart` and `contentEnd` of a block (from the real `splitBlocks`) carries that block's `meta.embedded.block.<tag>` scope, and nothing outside does;
  - spot checks: `export` in `<react>` is `keyword.control.export.tsx`, `$gap` in `<style lang="scss">` is `variable.scss`, `v-if` in `<vue>` and `{#if}` in `<svelte>` get the Vue and Svelte scopes.

### 2.3 VS Code extension package

- Build:
  - `packages/vscode/package.json` contributes the `ucf` language (`.ucf` extension, `icons/ucf.svg` as file icon, `language-configuration.json` with comments, brackets and auto closing pairs) and the grammar `source.ucf` with `embeddedLanguages` (`meta.embedded.block.react` → `typescriptreact`, style scopes → `css`, `scss`, `less`).
  - New devx command `pnpm devx vscode [--vsix]` (row in `scripts/lib/registry.mjs`, handler in `scripts/devx.mjs`): writes `generateGrammar()` to `packages/vscode/dist/syntaxes/`, and with `--vsix` packs `multifront-vscode-<version>.vsix` with `@vscode/vsce --no-dependencies` (everything is bundled, pnpm links never reach vsce). The version comes from `version.json`.
  - `packages/vscode` gets `tsconfig.json` (check only) and joins the root `vitest.config.ts` and `tsconfig.json` lists. It has no `tsconfig.build.json`: `devx typecheck` learns that this one package is built by the bundler, not `tsc`.
- Deliverable: a `.vsix` that highlights `.ucf` files once installed, with no other extension needed.
- Test: area **Editor**, `packages/e2e/editor/vsix.spec.ts`. Runs the real `pnpm devx vscode --vsix`, then the real `vsce ls`: the manifest, icon, `language-configuration.json`, our grammar and every vendored grammar and license are in the package. Then it tokenizes the `Greeting.ucf` fixture with the grammar files read from `dist/`, not from `generateGrammar()`, and gets the same scopes as 2.2.

### 2.4 `@multifront/language-tools` and the Volar language plugin

- Build:
  - New package `packages/language-tools`, `@multifront/language-tools`, exports `.`, `./typescript-plugin` and `./server` (each with the `source` condition). Exact-pinned deps: `@volar/language-core`, `@volar/typescript`. Peer: `typescript`. Joins the root `vitest.config.ts` and `tsconfig.json` references.
  - `src/blocks/index.ts`: the editor half of the registry, `editorBlockKinds`, same tags in the same order as core. Type in `src/types.ts`:

    ```ts
    interface EditorBlockKind {
      tag: BlockKind['tag'];
      types?(block: Block, ctx: EditorContext): VirtualFile;     // what an importer sees
      editor?(block: Block, ctx: EditorContext): VirtualFile[];  // embedded codes for the services
    }
    interface EditorContext {
      fileName: string;
      blocks: Block[];
      styleModules: Record<string, StyleClass[]>; // '$style' or the module name → its classes
    }
    ```

  - `src/blocks/style.ts`: `editor()` returns the block as one `.css` or `.scss` code mapped 1:1 to the block content (less and stylus: no code yet, highlighting only).
  - `src/blocks/react.ts`: `editor()` returns the block as one `.tsx` code mapped 1:1.
  - `src/languagePlugin.ts`: `createUcfLanguagePlugin(options)` returns a Volar `LanguagePlugin`. `getLanguageId` is `ucf` for `.ucf`. `createVirtualCode` splits once with `splitBlocks`, loops `editorBlockKinds` (shared rows first, so they fill `ctx`), and returns a root code with embedded codes `react` (`typescriptreact`) and `style_0`, `style_1`, ... (`css` / `scss`). `typescript.extraFileExtensions` has `ucf`; the TypeScript script is chosen as spike answer 3 says.
- Deliverable: a Volar language plugin that turns a `.ucf` file into mapped TSX and CSS / SCSS codes.
- Test: area **Editor**, `packages/e2e/editor/virtualCode.spec.ts`. Runs `createUcfLanguagePlugin().createVirtualCode()` on real fixtures (`Greeting.ucf`, `NamedModule.ucf`, the M1 splitter fixtures). Checks:
  - each embedded code against a file snapshot (`toMatchFileSnapshot('__snapshots__/Greeting.react.tsx')`, readable files);
  - every mapping is exact: the source slice equals the generated slice, for every segment;
  - the halves test: core `blockKinds` and `editorBlockKinds` list the same tags in the same order. It fails if a tag has only one half.

### 2.5 Typed `$style` and the `Card.ucf.react.tsx` types script

- Build:
  - Volar builds virtual codes synchronously, but `compileStyleAsync` is async (and the sync `compileStyle` refuses `modules`). So the style row's `editor()` finds the class names itself: preprocess with the sync `compileStyle` (no `modules`, so scss and less go through the same preprocessor as the build), then read the class selectors with `postcss` and `postcss-selector-parser` (exact pins). It fills `ctx.styleModules` with `StyleClass = {name: string; offset?: number}`, where `offset` points at the selector in the `.ucf` file when the name is written there literally (scss `&__title` has no literal place, so it types but has no jump).
  - The compiler comes from the project root through `loadVueCompiler(root)` in core (see Needs). It is an optional peer of `language-tools`; without it, only plain CSS class names are read.
  - `src/blocks/react.ts` `types()`: the block content plus one appended line per module, not mapped:

    ```ts
    declare const $style: {readonly card: string; readonly title: string};
    ```

    Named modules use their name (`declare const classes: ...`). The host names this file `Card.ucf.react.tsx`. Each class key gets a navigation-only mapping to its `offset`, so go to definition on `$style.card` lands on `.card`.
  - The `react` embedded code of 2.4 becomes this types script, so `$style` is typed inside the block too.
- Deliverable: `Card.ucf.react.tsx` with an exact `$style` type, from code that runs synchronously.
- Test: area **Editor**, `packages/e2e/editor/styleClasses.spec.ts`. For every M1 style fixture and every M2 fixture with `<style module>`, the class names the editor finds equal the keys of the class map from the real `compileStyles` (async, the build's path). Plus a file snapshot of `Greeting.ucf.react.tsx` and `NamedModule.ucf.react.tsx`.

### 2.6 Language server

- Build:
  - `src/server.ts`, subpath `./server`: `startServer()` on `@volar/language-server/node` with `createTypeScriptProject`, our language plugin, and three services: `volar-service-typescript` (TSX in `<react>`), `volar-service-css` (CSS / SCSS in `<style>`), and our own `multifront` service. The `multifront` service reports `splitBlocks` errors and every row's `check()` on the `.ucf` document itself, with the error code as the diagnostic code.
  - A bin, `multifront-language-server --stdio`, so other editors can start it too.
  - TypeScript comes from the client (`initializationOptions.typescript.tsdk`), never bundled.
- Deliverable: a language server with completions, errors, hover and go to definition in `<react>` and `<style>`.
- Test: area **Editor**, `packages/e2e/editor/server.spec.ts`, helper `packages/e2e/editor/lib/lsp.ts` (`startUcfServer(workspace)`, on `@volar/test-utils`, with `NODE_OPTIONS=--conditions=source` so it runs from source). Over real LSP, on real fixtures:
  - `<react>`: completion after `$style.` lists `card` and `title`; hover on `title` shows `string`; definition on `$style.card` lands on `.card` in `<style module>`; a type error in `TypeError.ucf` lands on the right line and column of the `.ucf` file.
  - `<style>`: completion of a property name; hover on `padding`; definition on `$gap` lands on its declaration; a CSS syntax error is reported in the block.
  - `BrokenBlocks.ucf`: a duplicate `<react>` gives `duplicate-target` on the second tag, and the first block still gets hover.

### 2.7 `resolveTarget()` v1 in core, and the shared imports fixture set

Decision: **yes, milestone 2 ships a first `resolveTarget()` in core.** The TypeScript plugin needs it, and the rules of spec 4.1 and 4.2 are pure and small. Milestone 3 extends it and wires it into Vite; it must keep the M2 signature, codes and rule order, which the editor tests pin.

- Build: `packages/core/src/resolveTarget.ts`, exported from core, types in `types.ts`:

  ```ts
  interface Importer { fileName: string; block?: Target } // block: the import sits in that .ucf target block
  interface ResolveTargetOptions { target?: Target; importers?: Record<string, Target> }
  type TargetChoice =
    | {target: Target; rule: 'block' | 'attribute' | 'importer' | 'default'}
    | {error: {code: 'framework-in-block' | 'unknown-framework' | 'no-target'; message: string}};
  const DEFAULT_IMPORTERS = {'.vue': 'vue', '.svelte': 'svelte', '.jsx': 'react', '.tsx': 'react'};
  function resolveTarget(importer: Importer, attribute: string | undefined, options?: ResolveTargetOptions): TargetChoice;
  ```

  Order: `block` (an attribute there is `framework-in-block`), then `attribute` (not a `Target` is `unknown-framework`), then the importer's extension in `{...DEFAULT_IMPORTERS, ...options.importers}`, then `options.target`, else `no-target` with a message naming the three ways. A non-literal attribute value is the caller's to detect (M3).

  The shared imports fixture set (spec section 10, "one shared fixture set"): `packages/e2e/fixtures/apps/imports/` with a `tsconfig.json` (`multifrontOptions.target: 'react'`), importers `src/App.tsx` (bare), `src/main.ts` (`with { framework: 'react' }`), `src/reexport.ts` (`export ... from` with `vue`), `src/lazy.ts` (dynamic import with `svelte`), `src/Page.vue` (bare), `src/mixed.ts` (same specifier, two frameworks), `no-default/bare.ts` (its own tsconfig, no target), and `expected.ts`: one row per import `{file, specifier, line, options, expect: Target | errorCode}`.
- Deliverable: one function that decides the framework of any `.ucf` import, and the table that the editor and the build must both satisfy.
- Test: package test `packages/core/test/resolveTarget.spec.ts`. Reads every row of `expected.ts`, reads the attribute from the real importer file, and checks `resolveTarget()` gives the expected target and rule, in spec order (an attribute beats the importer, the importer beats the default).

### 2.8 Imports inside a `.ucf` block

- Build: `src/resolve.ts` in language-tools: `resolveUcfImport(ts, literal, containingFile, options)`. It reads the `framework` attribute off the import node (spike answer 1), builds the `Importer` (a file named `X.ucf.<target>.tsx` is that block's importer), calls `resolveTarget()`, splits the imported file and returns its `X.ucf.<target>.tsx` when that file has a `types()` for the target. It bypasses TypeScript's shared resolution cache for `.ucf` specifiers, since the answer depends on the importer. Options come from `readMultifrontOptions(ts, configFileName)`: the `multifrontOptions` key of `tsconfig.json` (`{target?, importers?}`), the same way Vue reads `vueCompilerOptions`. The language server's TypeScript host calls it from `resolveModuleNameLiterals`. Errors become diagnostics at the import: `framework-in-block`, and "Avatar.ucf has no react block".
- Deliverable: inside `<react>`, `import Avatar from './Avatar.ucf'` gets Avatar's React types (spec 4.1), with no TypeScript plugin involved.
- Test: area **Editor**, `packages/e2e/editor/blockImports.spec.ts`, over real LSP: in `Greeting.ucf`, hover on `<Avatar` shows Avatar's props; a missing required prop is an error on the right line; definition on `Avatar` lands in `Avatar.ucf`'s `<react>` block; importing `VueOnly.ucf` reports the missing block naming both files; a `with { framework: 'vue' }` inside `<react>` reports `framework-in-block`.

### 2.9 TypeScript plugin

- Build: `src/typescriptPlugin.ts`, subpath `./typescript-plugin`: Volar's `createLanguageServicePlugin` with `createUcfLanguagePlugin`, then `resolveModuleNameLiterals` wrapped so `.ucf` specifiers go through `resolveUcfImport` and the rest go to TypeScript. `getSemanticDiagnostics` adds the `resolveTarget` errors at the import (and the warnings of 2.1, when a spike answer was "no"). A target with no types yet (`vue`, `svelte` until M4 and M6) leaves the module unresolved, with a message naming the target, so the test still sees which rule won. Module format as spike answer 4 says.
- Deliverable: `.ts` and `.tsx` files that import `.ucf` get the React types in any editor that loads tsserver plugins.
- Test: area **Editor**, `packages/e2e/editor/tsserver.spec.ts`, helper `packages/e2e/editor/lib/tsserver.ts` (`startTsserver({cwd})`, `request(command, args)`). Starts the real `tsserver.js` of TypeScript 6.0.3 with `--globalPlugins @multifront/language-tools/typescript-plugin` and `--conditions=source`, on `fixtures/apps/imports/`:
  - every row of `expected.ts` with a `.ts` or `.tsx` importer: `react` rows resolve to `Greeting.ucf.react.tsx`; `vue` and `svelte` rows report their target; error rows report their code;
  - in `App.tsx`: `quickinfo` on `<Greeting` shows its props, a wrong prop type is an error, `definition` lands on `Greeting.ucf` inside `<react>`;
  - `mixed.ts` behaves as spike answer 2 decided.

### 2.10 The extension starts the server and loads the plugin

- Build:
  - `packages/vscode/src/extension.ts`: on the `ucf` language, starts the server with `@volar/vscode` and `vscode-languageclient`, passing the tsdk of VS Code's built-in TypeScript extension.
  - `pnpm devx vscode` now also bundles with Vite's library mode (Rolldown, already at the root): `dist/extension.cjs` (external `vscode`), `dist/server.cjs` (the language server and core), and the TypeScript plugin into `packages/vscode/node_modules/multifront-typescript-plugin-pack/` (gitignored), because `contributes.typescriptServerPlugins` resolves plugin names from the extension's own `node_modules`, as Vue's extension does. `enableForWorkspaceTypeScriptVersions: true`.
  - No `languages: ["ucf"]` on the plugin entry in M2: that would make VS Code's TypeScript features run inside `.ucf` too, next to our server's. See "Risks".
- Deliverable: one `.vsix` with the grammar, the server and the TypeScript plugin, nothing else to install.
- Test: area **Editor**, `packages/e2e/editor/bundle.spec.ts`. After the real `pnpm devx vscode`: the hover and diagnostic cases of 2.6 run again against `dist/server.cjs` (no `source` condition), and the `App.tsx` quickinfo case of 2.9 runs again with tsserver loading the plugin pack from `packages/vscode/node_modules`. This catches anything the bundle drops.

### 2.11 Real VS Code test harness

- Build: `packages/e2e/editor/vscode/`: `exit.spec.ts` starts a pinned VS Code with `@vscode/test-electron` (`.vscode-test/` cache, gitignored), loading `packages/vscode` as the development extension and `fixtures/apps/imports/` as the workspace. `suite.cjs` runs inside VS Code, checks with `node:assert` and writes its results to a JSON file the spec reads. CI runs it under `xvfb-run`.
- Deliverable: a way to run any editor check in the real VS Code, for this milestone and the next ones.
- Test: the exit test below.

## Hands to later milestones

- **`resolveTarget(importer, attribute, options)`** in `packages/core/src/resolveTarget.ts`, with `Importer`, `ResolveTargetOptions`, `TargetChoice`, `DEFAULT_IMPORTERS` and the codes `framework-in-block`, `unknown-framework`, `no-target`. M3 extends it (the `targets` list, a non-literal value, the imported file missing the block) and calls it from Vite. It keeps the M2 signature, codes and order.
- **Imports fixture set** `packages/e2e/fixtures/apps/imports/` and its `expected.ts`. M3 runs the same rows through real Vite builds, so the build and the editor are proven to agree (spec section 10). M4 adds the `.vue` importer rows to the tsserver run, M6 the `.svelte` ones.
- **`multifrontOptions`** in `tsconfig.json` (`{target?, importers?}`) and `readMultifrontOptions(ts, configFileName)`. M3 decides if the Vite plugin reads it as its default, so editor and build cannot drift.
- **Core registry rows** `react`, `vue`, `svelte` in `packages/core/src/blocks/` with `grammar` only. M3 fills react's `check` and `build`, M4 vue's, M6 svelte's.
- **`editorBlockKinds`** in `packages/language-tools/src/blocks/index.ts` and the types `EditorBlockKind`, `EditorContext`, `StyleClass`. M4 fills vue's `types()` (`Card.ucf.vue.ts`) and `editor()`, M6 svelte's (`Card.ucf.svelte.ts`). M7's `mf-tsc` calls every row's `types()`.
- **`react` `types()`**, the `Card.ucf.react.tsx` script with the typed `$style`. M5 emits the React package's `.d.ts` from it.
- **`createUcfLanguagePlugin(options)`** (`src/languagePlugin.ts`) and **`resolveUcfImport(ts, literal, containingFile, options)`** (`src/resolve.ts`). M4 and M6 reuse them for `.vue` and `.svelte` importers; M7's `mf-tsc` builds on both.
- **`startServer()`** at `@multifront/language-tools/server` and the bin `multifront-language-server`. M4 adds the Vue services, M6 the Svelte ones, M7 formatting and linting.
- **`@multifront/language-tools/typescript-plugin`**. M4 runs it beside Vue's own TypeScript plugin.
- **`generateGrammar(kinds)`** (`multifront-vscode/grammar`), the vendored grammars in `packages/vscode/syntaxes/vendor/`, and **`pnpm devx vscode [--vsix]`**. Every later block kind gets highlighting from its `grammar` field.
- **Editor test helpers** in `packages/e2e/editor/lib/`: `tokenizeUcf(path)`, `startUcfServer(workspace)`, `startTsserver({cwd})`, and the VS Code harness `packages/e2e/editor/vscode/`. M4, M6 and M7 add their cases with them.
- **Fixtures** in `packages/e2e/fixtures/components/`: `Greeting.ucf` (all four blocks, `<style module lang="scss">` and `<style scoped>`, imports `Avatar.ucf`), `Avatar.ucf` (`<react>` and `<vue>`), `VueOnly.ucf`, `NamedModule.ucf` (`<style module="classes">`), `TypeError.ucf`, `BrokenBlocks.ucf`.
- `loadVueCompiler(root)` in core, if step 2.5 had to move it there.

## Exit test

`packages/e2e/editor/vscode/exit.spec.ts`, in the real VS Code, with the extension built by `pnpm devx vscode`, on `fixtures/apps/imports/`:

1. `Greeting.ucf` opens with language id `ucf`, and `_workbench.captureSyntaxTokens` (VS Code's own colorize test command) gives TSX scopes in `<react>`, SCSS scopes in `<style lang="scss">`, and Vue and Svelte scopes in `<vue>` and `<svelte>`.
2. In `<react>`: `vscode.executeCompletionItemProvider` after `$style.` lists `card` and `title`; `vscode.executeHoverProvider` on `<Avatar` shows its props; `vscode.executeDefinitionProvider` on `$style.card` lands on `.card`.
3. In `<style>`: hover on a property shows CSS docs.
4. `vscode.languages.getDiagnostics` on `TypeError.ucf` has the type error on the right line, and on `BrokenBlocks.ucf` has `duplicate-target`.
5. In `App.tsx`, served by VS Code's own tsserver with our plugin: hover on `<Greeting` shows the props from `Greeting.ucf`, and definition lands inside its `<react>` block.

## Risks and open questions

- **One resolution per specifier per file.** TypeScript stores resolutions per (specifier, mode), so `./Card.ucf` imported as React and as Vue in one file gets one type. Expected from spike 1; the fix is a re-export file per framework, and the plugin says so.
- **TypeScript 7 (native) has no JavaScript plugin API.** Our tsserver plugin works on TypeScript 6. If VS Code moves to the native TypeScript, importers lose `.ucf` types until a plugin API exists. Vue's tools face the same. Watch it; nothing to build now.
- **Volar extra service scripts** (spike answer 3) may not carry every LSP feature. Fallback: the React code as the main script in M2, and per-target scripts solved in M4.
- **Grammar and splitter can disagree.** An embedded TSX rule (a string, a template literal, a JSX tag the TSX grammar misreads) can run past `</react>`. The 2.2 cross-check against `splitBlocks` catches it on the fixtures; the `</react>` in a string case is a documented limitation in both.
- **Sync class names vs the build's class map.** A project PostCSS config that renames classes would make them differ. The 2.5 test guards the fixtures only.
- **Two TypeScript programs.** The server runs its own TypeScript for `.ucf` files, and tsserver runs one for `.ts` files. So an unsaved edit in `Card.ucf` reaches `App.tsx` only on save. Open question: switch to Vue's "hybrid mode" (tsserver serves TypeScript inside `.ucf` too) before M4, since Vue's own tools now only work that way.
- **Editor and build options can drift**: `multifrontOptions` in `tsconfig.json` vs the Vite plugin's options. Open for M3.
- **Open, for the M1 reviewer:** do `check` and `build` allow being missing on a row; does the grammar shape have per-`lang` scopes; do `splitBlocks` errors carry offsets; is `VirtualFile.map` offset segments; does core already load `@vue/compiler-sfc` without Vite.
- **Open:** the attribute key, `framework` or `target` (spec section 12). M2 reads `framework` only.
- **Open:** the extension's publisher id, needed before any Marketplace or Open VSX release.

## Out of scope

- `<vue>` and `<svelte>` language features (M4, M6); in M2 they are highlighted only.
- Types for `.vue` and `.svelte` importers (M4, M6). The rules pick them already; the types scripts come later.
- `mf-tsc`, `mf-lint`, `mf-fmt`, formatting and linting in the editor (M7).
- Language features for `less` and `stylus` blocks (highlighting only).
- The Vite side of `resolveTarget()` and the attribute rewrite (M3); the `.ucf/types/*.d.ts` build output (M3, M5).
- Publishing to the VS Code Marketplace and Open VSX.
- Testing other editors (WebStorm, Neovim). The subpaths and the bin are ready for them.
