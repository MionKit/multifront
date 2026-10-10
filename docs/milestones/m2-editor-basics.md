# Milestone 2: Editor basics

## Goal

Open a `.ucf` file in VS Code and get a real editor from day one:

- Highlighting in every block (`<react>`, `<vue>`, `<svelte>`, `<style>`), from a TextMate grammar generated from the block kind registry.
- Inside `<react>`: TypeScript completions, errors, hover and go to definition, with `$style` typed from the class names of `<style module>`.
- Inside `<style>`: CSS and SCSS completions, errors, hover and go to definition.
- Outside: a `.ts` or `.tsx` file that imports `./Card.ucf` gets the React component types, picked by the same `resolveTarget()` the build will use.

It works in **hybrid mode from day one** (spec 6): VS Code's own tsserver, with our TypeScript plugin, does every TypeScript job, inside `.ucf` blocks too. Our language server does the rest (CSS, our own diagnostics). One TypeScript program, so an unsaved edit in `Card.ucf` reaches `App.tsx` at once, and rename and find references cross `.ucf` and `.ts` files.

This is spec section 6, steps 1 to 3. Two new packages: `@multifront/language-tools` (npm) and `packages/vscode` (the extension, `multifront-vscode`, private, never on npm).

## Needs from earlier milestones

From milestone 1, in `@multifront/core` (names as in [m1-splitter-block-kinds-styles.md](m1-splitter-block-kinds-styles.md)):

- `splitBlocks(source, filename): SplitResult`, which never throws and keeps every readable block after an error. `SplitResult` is `{filename, source, blocks, styles, targets, errors}`.
- `Block`: `{type, attrs, content, start, end, contentStart, contentEnd, index}`, with `attrs` holding `lang`, `module` (`true` or a name) and `scoped`.
- `checkBlocks(split): Diagnostic[]`, and `Diagnostic`: `{code, severity, message, filename, start, end, line, column}` (offsets into the `.ucf` source, `line` 1-based, `column` 0-based). `DiagnosticCode` is a union that later milestones add to.
- `BlockKind`, `BlockTag`, `BlockRole`, `BLOCK_KINDS` (order `style, vue, react, svelte`) and `getBlockKind(tag)`, in `packages/core/src/blocks/index.ts`. Every row has `grammar`; `build` may be missing.
- `BlockGrammar` and `GrammarScope`: `{scopeName, languageId, byLang?}`, with the M1 values (`react` → `source.tsx`, `vue` → `text.html.vue`, `svelte` → `source.svelte`, `style` → `source.css` and per `lang` `source.css.scss`, `source.sass`, `source.css.less`, `source.stylus`, `source.css.postcss`).
- `VirtualFile`: `{ext, code, map: SourceMap | undefined}`.
- `createBuildContext(split, {root, compiler, production})` and `ctx.modules[name].classes` (local → generated). M2 uses them in one test only, to prove the editor's class names match the build's.
- `VueCompiler` (owned by core) and `getVueCompiler(plugins, root)` in `@multifront/vite`.
- `Target`, `TARGETS`, `isTarget`.

From milestone 1, in `packages/e2e` (`@multifront/e2e`, vitest project `e2e`):

- The fixture helpers in `packages/e2e/fixtures/index.ts`: `FIXTURES_DIR`, `componentPath()`, `readComponent()`, `listComponents()`, `copyApp()`.
- The valid components `Card.ucf` (all four blocks, `<style module lang="scss">`), `Badge.ucf`, `Button.ucf` (`<style module="classes">`), `Panel.ucf` (scss variable and nesting), `Hello.ucf`, `TsxEdges.ucf`, and every fixture in `fixtures/components/invalid/`. M2 reads them and never edits them.
- Root devDependencies `shiki` (real TextMate grammars), `sass`, `vue`, `@vitejs/plugin-vue`.

Not in milestone 1, so M2 adds it (step 2.5): a way to load `@vue/compiler-sfc` without Vite, and the sync `compileStyle` in the `VueCompiler` type.

## Steps

### 2.1 Spike: types by import attribute (throwaway)

Spike 1 of [plan.md](../plan.md) "Prototype first". The code is thrown away; only the answers stay.

- Build: a scratch tsserver plugin (not merged), loaded into the real tsserver of TypeScript 6.0.3, with one `.ucf` file and a few importers. It answers six questions:
  1. Inside `resolveModuleNameLiterals`, can we reach the import node of each literal (`literal.parent`, or by walking `containingSourceFile` when parent links are not set yet) and read `with { framework: 'react' }` on a static import, an `export ... from` and `import('./Card.ucf', { with: { framework: 'react' } })`?
  2. Two imports of the same specifier with different frameworks in one file: does TypeScript keep two resolutions, or one per (specifier, mode)? We expect one.
  3. Can `./Card.ucf` resolve to a file that is not on disk, `/abs/Card.ucf.react.tsx`, served as a Volar extra service script (`getExtraServiceScripts`), and do hover and go to definition map back into the `.ucf` file?
  4. Does tsserver load an ESM plugin (`require(esm)`) under Node 26 and inside the pinned VS Code, or must the plugin ship as one CJS file?
  5. Does TypeScript accept the `framework` key with no error under `module: preserve` and `module: nodenext`?
  6. Hybrid mode: with `"languages": ["ucf"]` on the plugin entry, does tsserver open `.ucf` files through our plugin and serve completion, hover, definition, rename and references inside `<react>`, and does an unsaved `Card.ucf` edit (tsserver `change` command, no save) reach `App.tsx`?
- Deliverable: the answers written into plan.md, spike 1, and the decision for each "no":
  - **No to 1:** types follow the importer's framework and the default target only. Per-import attributes are dropped from types; the build still honours them. The TypeScript plugin warns on an attribute that picks another framework than the types use ("types follow react here, the build uses vue"). It can read the attribute in `getSemanticDiagnostics`, where the full tree exists. Spec section 5 and the imports fixture set (2.7) mark the attribute rows "build only".
  - **Expected limit on 2:** one framework per specifier per file, in types only. The plugin warns on the second import and names the fix: one small re-export file per framework.
  - **No to 3:** in M2 the `.ucf` file's main service script is the React code. Milestone 4 must solve per-target scripts before it adds Vue.
  - **No to 4:** the `./typescript-plugin` subpath ships one bundled `.cjs` file, the one exception to "ESM only".
  - **No to 6:** fall back to two programs (our server runs its own TypeScript for `.ucf` files, tsserver serves `.ts` importers), and record the limits: importers see `.ucf` changes on save only, rename and references stop at the file kind. Milestone 4 must then re-check, because Vue's current tools assume hybrid mode.
- Test: the spike's own script runs the real tsserver over its stdio protocol and prints the file each import resolves to. Its cases become the tsserver cases of 2.9.
- Status: done

### 2.2 Grammar from the registry

- Build:
  - New folder `packages/vscode`, package `multifront-vscode`, private, with `tsconfig.json` (check only) and a `vitest.config.ts` project in the root `vitest.config.ts` list (`pnpm devx typecheck` fails for a package missing there). It is private, so it gets no `tsconfig.build.json` and no root reference, like `packages/e2e`.
  - `src/grammar.ts` exports `generateGrammar(kinds = BLOCK_KINDS): GrammarFile[]` (`GrammarFile`: `{scopeName, path, grammar, injectTo?}` in `src/types.ts`, `path` = `<scopeName>.tmLanguage.json`). The first file is the root grammar `source.ucf`: an HTML comment rule, then per tag one begin/end rule with the splitter's tag rules: begin `(<)(react)(?![^\s/>])(?![^>]*/>)` (a self-closing tag opens nothing), attributes may span lines, a quote holding `>` or running past the line ends the rule (the splitter drops that tag), end `(</)(react)(?=[\s>])[^>]*(>)?` (the first closing tag ends the block). The content after `>` has `contentName: meta.embedded.block.<tag>` and an include of the row's `grammar.scopeName`. For `<style>`, a `lang="x"`, `lang='x'` or `lang = x` attribute on any line of the tag starts a nested rule whose content is `meta.embedded.block.style.<languageId>` with that `byLang` grammar; a `lang=` inside another attribute's quoted value picks nothing, as in the splitter.
  - Pinned copies of the Vue grammar (with its four injection grammars: directives, interpolations, script leading operator fix, style variable injection) and the Svelte grammar, both MIT, in `packages/vscode/syntaxes/vendor/vue/` and `svelte/` with their licenses and `sources.json` (upstream repo, commit, paths). Upstream Svelte ships YAML only; the copy is its js-yaml conversion, as upstream's `build:grammar` does. The registry keeps `text.html.vue` and `source.svelte`; `generateGrammar` serves our copies as `source.ucf.vue` and `source.ucf.svelte`, and each injection grammar under the copy's scope (`source.ucf.vue.vue.directives`, ..., `injectTo: ['source.ucf']`), so they never clash with the official Vue or Svelte extension. VS Code reads injections only from the document's root grammar, so Svelte's own `injections` move to `source.ucf`, and every moved or injected selector is limited to its block: the block scope goes in front (`L:meta.embedded.block.vue meta.tag …`), or takes the place of an upstream root scope the selector names (`L:text.html.vue source.js` → `L:meta.embedded.block.vue source.js`). Token scopes inside stay the same, so themes colour them the same.
  - `packages/vscode` exports `./grammar` (with the `source` condition) so the e2e package can import it. `@multifront/e2e` gets `multifront-vscode: workspace:*`.
  - Root devDependencies, exact pins: `vscode-textmate` 9.3.2, `vscode-oniguruma` 2.0.1.
- Deliverable: the full grammar set (ours plus the renamed vendored copies) generated from the registry. A new registry row gets highlighting with no grammar edit.
- Test: area **Editor**, `packages/e2e/editor/grammar.spec.ts`, helper `packages/e2e/editor/lib/tokenize.ts` (`tokenizeUcf(path, grammars)`, `hasScope(token, scope)`). It loads `generateGrammar()` into the real `vscode-textmate` with `vscode-oniguruma`, through JSON text as VS Code reads the files. The grammars VS Code ships built in (`source.tsx`, `source.css`, `source.css.scss`, `text.html.basic`, ...) come from `shiki`. For every name in `listComponents()`, `listComponents('langs')`, `listComponents('editor')`, `invalid/BrokenOpeningTags.ucf` and `invalid/UnknownRootTag.ucf`:
  - every character between `contentStart` and `contentEnd` of a block (from the real `splitBlocks`) carries that block's content scope (`meta.embedded.block.<tag>`, with `.<languageId>` when `lang` picks a `byLang` grammar), no character outside carries one, and no Vue or Svelte scope shows outside its own block;
  - new fixture `editor/GrammarEdges.ucf` (a `<style>` tag over several lines with `lang` on a later line, `lang='less'`, `title="a lang=scss b"`, a Vue `<script setup>` line starting with `<`, a Svelte `<template>`): the leading `<` is `keyword.operator.relational.js` and `{` in the Svelte `<template>` is `punctuation.section.embedded.begin.svelte`;
  - spot checks: in `Card.ucf`, `export` in `<react>` is `keyword.control.export.tsx`, `:class` and `{{` in `<vue>` get the Vue directive and interpolation scopes, `{title}` and `let` in `<script lang="ts">` of `<svelte>` get the Svelte and TypeScript scopes; in `Panel.ucf`, the scss variable is `variable.scss`; every grammar scope starts with `source.ucf`, and no `include` names an upstream scope;
  - `TsxEdges.ucf` (`<>`, `<T,>`, `a < b`) ends its `<react>` scope exactly at `</react>`;
  - `invalid/ReactCloseInString.ucf` shows the documented limit: the `<react>` scope runs past the closing tag the splitter takes.
- Status: done

### 2.3 VS Code extension package and `pnpm devx vsix`

- Build:
  - `packages/vscode/package.json` contributes the `ucf` language (`.ucf` extension, `icons/ucf.svg` as file icon, `language-configuration.json` with comments, brackets and auto closing pairs) and every grammar of `generateGrammar()` (the injection grammars with their `injectTo`). Its `embeddedLanguages` come from each row's `grammar.languageId` (`meta.embedded.block.react` → `typescriptreact`, `meta.embedded.block.style` → `css`, `meta.embedded.block.style.<languageId>` → `scss`, `less`, ...).
  - New devx command `pnpm devx vsix` (row in `scripts/lib/registry.mjs`, handler in `scripts/devx.mjs`): writes `generateGrammar()` to `packages/vscode/dist/syntaxes/`, then packs `packages/vscode/multifront-vscode-<version>.vsix` (gitignored) with `@vscode/vsce package <version> --no-update-package-json --no-dependencies`. The `files` list in `package.json` names what ships (the generated grammars, the vendored licenses, the icon, the language configuration, `LICENSE`), so pnpm's links never reach vsce. The version comes from `version.json`, into the packed manifest only. `engines.vscode`, `repository` and a `LICENSE` (copied from the root at pack time, gitignored) are there because vsce needs them or prompts without them; `publisher` waits for M7. Root devDependency `@vscode/vsce` 3.9.2, exact pin (4.0.0 is under the 30-day release age).
- Deliverable: a `.vsix` that highlights `.ucf` files once installed, with no other extension needed.
- Test: area **Editor**, `packages/e2e/editor/vsix.spec.ts`. Runs the real `pnpm devx vsix`, then the real `vsce ls --no-dependencies` in `packages/vscode`: the manifest, the icon, `language-configuration.json`, our grammar and every vendored grammar and license are in the package. Then it tokenizes `Card.ucf` with the grammar files read from `dist/syntaxes/` (not from `generateGrammar()`) and gets the same scopes as 2.2.
- Status: done

### 2.4 `@multifront/language-tools` and the Volar language plugin

- Build:
  - New package `packages/language-tools`, `@multifront/language-tools`. Exports `.` (with the `source` condition); `./server` comes with its code in 2.6, `./typescript-plugin` in 2.9. Exact-pinned dependencies: `@multifront/core` (`workspace:*`), `@volar/language-core` and `@volar/typescript` 2.4.28. Peer: `typescript` `^6.0.0`. Joins the root `vitest.config.ts` projects and the root `tsconfig.json` references. `@multifront/e2e` gets it as `workspace:*`. Root devDependency `@volar/language-core` 2.4.28 (exact pin), so the test runs Volar's own registry.
  - `src/blocks/index.ts`: the editor half of the registry, `EDITOR_BLOCK_KINDS`, same tags in the same order as `BLOCK_KINDS`. Types in `src/types.ts`:

    ```ts
    interface EditorBlockKind {
      tag: BlockTag;
      types?(block: Block, ctx: EditorContext): EditorFile;    // what an importer sees: Card.ucf.<target><ext>
      editor?(block: Block, ctx: EditorContext): EditorFile[]; // embedded codes for the language services
    }
    interface EditorFile extends VirtualFile {
      mappings: CodeMapping[]; // Volar offsets with feature flags; `map` stays undefined
    }
    interface EditorContext {
      split: SplitResult;
      modules: Record<string, EditorStyleModule>; // '$style' or the module name; filled by shared rows first
    }
    interface EditorStyleModule { name: string; index: number; classes: StyleClass[] }
    interface StyleClass { name: string; offset?: number } // offset of `.name` in the .ucf file, when written there
    ```

    `EditorFile` keeps the `VirtualFile` name and shape. It adds Volar mappings because a v3 source map has no exact spans and no per-span feature flags.
  - `src/blocks/style.ts`: `editor()` returns the block as one `.css` or `.scss` code, mapped 1:1 to the block content. `less`, `sass`, `stylus` and `postcss` blocks: no code yet, highlighting only.
  - `src/blocks/react.ts`: `editor()` returns the block as one `.tsx` code, mapped 1:1.
  - `src/languagePlugin.ts`: `createUcfLanguagePlugin()` returns a Volar `LanguagePlugin`. `getLanguageId` is `ucf` for `.ucf`. `createVirtualCode` splits once with `splitBlocks`, loops `EDITOR_BLOCK_KINDS` (shared rows first, so they fill `ctx`), and returns a root code with embedded codes `react` (`typescriptreact`) and `style_0`, `style_1`, ... (`css` or `scss`). A target row reads its first block only, as the build does; a shared row every block of its tag. `typescript.extraFileExtensions` has `ucf`. The TypeScript script is the `react` code, returned by `getServiceScript` as the `.ucf` file's main service script: Volar's tsserver plugin does not serve `getExtraServiceScripts` (spike 1, answer 3). No parameter yet: the first step that needs an option adds it.
- Deliverable: a Volar language plugin that turns a `.ucf` file into mapped TSX and CSS / SCSS codes.
- Test: area **Editor**, `packages/e2e/editor/virtualCode.spec.ts`. Loads `createUcfLanguagePlugin()` into Volar's real `createLanguage()` and sets every name in `listComponents()`, `listComponents('langs')`, `listComponents('editor')` and every invalid fixture. Checks:
  - each embedded code against a readable file snapshot (`toMatchFileSnapshot('__snapshots__/virtualCode/Card.ucf.react.tsx')`);
  - every mapping is exact: for every segment, the source slice equals the generated slice;
  - invalid fixtures still give codes for the blocks `splitBlocks` kept (for example `invalid/DuplicateReact.ucf` keeps its `<style>` code);
  - the halves check: `BLOCK_KINDS` and `EDITOR_BLOCK_KINDS` list the same tags in the same order. It fails if a tag has only one half;
  - a `.ts` file gets no code;
  - `packages/e2e/editor/builtTypes.spec.ts`: after the real `tsc --build` of the package, a consumer without the `source` condition (`fixtures/apps/language-tools-dist/`) typechecks against `dist/` and sees the plugin's `typescript` field.
- Status: done

### 2.5 Typed `$style` and the `Card.ucf.react.tsx` types script

- Build:
  - Volar builds virtual codes synchronously. `compileStyleAsync` is async, and the sync `compileStyle` refuses `modules`. So the style row's `editor()` finds the module keys itself (`src/styleClasses.ts`): it preprocesses with the sync `compileStyle` (no `modules`, with core's `stylePreprocessOptions(block)`, so scss runs through the same preprocessor as the build), then reads the keys postcss-modules exports with `postcss` and `postcss-selector-parser` (exact pins): the class selectors (not under `:global`), `@keyframes` names, `@value` names and root `:export` props. It fills `ctx.modules` (core's `moduleName(block)` names the module; a later same-name block wins, as in the build). A `StyleClass` gets an `offset`, the offset of the name itself (`card` in `.card`), when the name is written in the block (scss `&__title` has no literal place, so it is typed but has no jump target). A module that cannot be read (a style mid-edit, a preprocessor or compiler missing) has `classes: undefined`.
  - In core: `VueCompiler` gains `compileStyle`, and a new `loadVueCompiler(root): VueCompiler` holds the "resolve `vue/compiler-sfc`, then `@vue/compiler-sfc`, from the project root" lookup. `getVueCompiler` in `@multifront/vite` calls it for its fallback, so the lookup lives in one place. Core also exports `stylePreprocessOptions(block)` and `moduleName(block)`, which the build and the editor share. `@vue/compiler-sfc` is an optional peer of `language-tools`; the caller passes it as `EditorOptions.compiler`, and without it only plain CSS class names are read.
  - `src/blocks/react.ts` `types()`: the block content, plus one unmapped line per module at the end:

    ```ts
    declare const $style: {readonly card: string; readonly title: string};
    ```

    A named module uses its name (`declare const classes: ...`); a key that is not an identifier is quoted. A module that cannot be read gets the loose `{readonly [name: string]: string}`, so a style mid-edit never turns every `$style.x` red (the CSS service reports the style error). Tools name this script `Card.ucf.react.tsx`; tsserver serves it as the `.ucf` file's own script (2.4), so it sees it as `Card.ucf`. Each class key gets a navigation-only mapping to its `offset`, so go to definition on `$style.card` lands on `.card`.
  - The `react` embedded code of 2.4 becomes this types script, so `$style` is typed inside the block too.
  - `EditorOptions {compiler?: VueCompiler}` is the first option: `createUcfLanguagePlugin(options?)`. `EditorContext` carries it as `compiler`.
  - A public helper for tools that need a types script without a language server: `getTypesScript(filename, source, target, options?: EditorOptions): EditorFile | undefined`, exported from `@multifront/language-tools` (`src/typesScript.ts`) (splits, fills `ctx`, calls that target's `types()`). M5 emits `.d.ts` files with it.
- Deliverable: `Card.ucf.react.tsx` with an exact `$style` type, built synchronously.
- Test: area **Editor**, `packages/e2e/editor/styleClasses.spec.ts`. For every name in `listComponents()` and the new `editor/StyleModuleEdges.ucf` (nesting, `:global`, `:not`, `@media`, keyframes, `@value`, `:export`, sass, names in comments and strings), the keys the types script declares per module equal the keys of `ctx.modules[name].classes` from the real, async `createBuildContext()` (the build's path, real `@vue/compiler-sfc` and `sass`), and every key mapping lands on that name in a `<style>` block of its module. Without a compiler, a plain CSS module is still read and a scss one is typed loosely; `editor/LessModule.ucf` (no less installed) is typed loosely too. Plus readable file snapshots of `Card.ucf.react.tsx` (`$style`) and `Button.ucf.react.tsx` (`classes`). Package test `packages/core/test/vueCompiler.spec.ts` for `loadVueCompiler`.
- Status: done

### 2.6 Language server

- Build:
  - `src/server.ts`, subpath `./server` (new in `exports`, with the `source` condition): `startServer()` on `@volar/language-server/node.js` (`createSimpleProject`) with our language plugin and two services: `volar-service-css` (CSS and SCSS in `<style>`) and our `multifrontService` (`src/multifrontService.ts`). No TypeScript service: in hybrid mode tsserver does every TypeScript job (2.9). When the server needs type information (Vue and Svelte markup in M4, M6, M7), it asks tsserver through the client, the way Vue's server does. The `multifront` service reports `checkBlocks(split)` on the `.ucf` document itself (the root code keeps its split, `UcfVirtualCode`), with `source: 'multifront'`, the `Diagnostic.code` as the LSP code and `start` / `end` as the range. The language plugin gets no Vue compiler: it only types `$style` in the React code, which no service of this server reads. Exact pins: `@volar/language-server` and `@volar/language-service` 2.4.28, `volar-service-css` 0.0.71, `vscode-uri` 3.2.0.
  - A bin, `multifront-language-server --stdio` (`bin/multifront-language-server.js`, which imports the package's own `./server` export), so other editors can start it too.
  - The server never bundles or imports TypeScript. The first service that needs it (M4) loads it from `initializationOptions.typescript.tsdk`; 2.10 still passes the tsdk.
  - Root devDependency `@volar/test-utils` 2.4.28 (a real LSP client that starts the server as a child process), exact pin.
- Deliverable: a language server with completions, errors, hover and go to definition in `<style>`, and our own diagnostics on the whole `.ucf` file.
- Test: area **Editor**, `packages/e2e/editor/server.spec.ts`, helper `packages/e2e/editor/lib/lsp.ts` (`startLanguageServer(workspace)`: the bin as installed in `packages/e2e/node_modules`, on `@volar/test-utils`, with `NODE_OPTIONS=--conditions=source` so it runs from source, diagnostics pulled as VS Code does; the handle adds `stop()`). Over real LSP:
  - `<style>` of `Panel.ucf`: completion of a property name; hover on a property shows its CSS docs; definition on its scss variable lands on the declaration.
  - every fixture in `invalid/`: the diagnostics the server sends with `source: 'multifront'` equal `checkBlocks()` for that file (code, severity, range, message); the same for an unsaved (`untitled:`) buffer; valid `Card.ucf` gets none.
  - the TypeScript cases (`<react>` completion, hover, definition, type errors) are tsserver tests, in 2.9.
- Status: done

### 2.7 `resolveTarget()` v1 in core, and the shared imports fixture set

**Decision: yes, milestone 2 ships a first `resolveTarget()` in core.** The TypeScript plugin needs it, and the rules of spec 4.1 and 4.2 are pure and small. Milestone 3 extends it and calls it from Vite. It keeps the M2 signature, codes and rule order, which the editor tests pin.

- Build: `packages/core/src/imports/resolveTarget.ts`, exported from core, types in `types.ts`:

  ```ts
  interface Importer { fileName: string; block?: Target } // block: the import sits inside that .ucf target block
  interface ResolveTargetOptions { framework?: Target; importers?: Record<string, Target> }
  type TargetRule = 'block' | 'attribute' | 'importer' | 'default';
  type TargetChoice = {target: Target; rule: TargetRule} | {error: {code: DiagnosticCode; message: string}};
  const DEFAULT_IMPORTERS: Readonly<Record<string, Target>>; // '.vue' vue, '.svelte' svelte, '.jsx' and '.tsx' react
  function resolveTarget(importer: Importer, attribute: string | undefined, options?: ResolveTargetOptions): TargetChoice;
  ```

  Order: `block` (an attribute there is `framework-in-block`), then `attribute` (a value that is not a `Target` is `unknown-framework`), then the importer's extension in `{...DEFAULT_IMPORTERS, ...options.importers}`, then `options.framework`, else `no-target`, whose message names the three ways. The three codes join `DiagnosticCode`. The caller adds the position. A non-literal attribute value is for the caller to detect (M3).

  The shared imports fixture set (spec section 10: "one shared fixture set"), `packages/e2e/fixtures/apps/imports/`:
  - `tsconfig.json` (`jsx: react-jsx`, `module: preserve`, `moduleResolution: bundler`) with the plugin entry `{"name": "@multifront/language-tools/typescript-plugin", "framework": "react"}` in `compilerOptions.plugins`;
  - importers of `fixtures/components/Card.ucf`: `src/App.tsx` (bare), `src/main.ts` (`with { framework: 'react' }`), `src/reexport.ts` (`export ... from` with `vue`), `src/lazy.ts` (dynamic import with `svelte`), `src/bad.ts` (`framework: 'angular'`), `src/Page.vue` (bare), `src/mixed.ts` (same specifier, two frameworks);
  - `no-default/` with its own `tsconfig.json` (no `framework`) and `bare.ts`;
  - `expected.ts`: one row per import, `{file, specifier, line, options, expect: Target | DiagnosticCode}`.
  - Root devDependencies `react` and `@types/react`, exact pins.
- Deliverable: one function that decides the framework of any `.ucf` import, and the table the editor and the build must both satisfy.
- Test: package test `packages/core/test/resolveTarget.spec.ts`. For every row of `expected.ts`, reads the real importer file (relative path, as M1's core tests do), takes the attribute from its import, and checks `resolveTarget()` gives the expected target and rule. The rows prove the order: an attribute beats the importer, the importer beats the default.

### 2.8 Imports inside a `.ucf` block

- Build:
  - `src/resolve.ts` in language-tools: `resolveUcfImport(ts, literal, containingFile, options)`. It reads the `framework` attribute from `literal.parent`, the import node (spike 1, answer 1: only that one parent link is set, so it passes the source file to `getStart()` / `getText()`), builds the `Importer` (the `Card.ucf.<target><ext>` script, or the `.ucf` file's own script, is that block's importer), calls `resolveTarget()`, splits the imported file, and returns the imported `.ucf` file itself when that file's row has `types()` (in M2 only `react`, the file's main service script). It does not use TypeScript's shared resolution cache for `.ucf` specifiers, because the answer depends on the importer.
  - `readMultifrontOptions(ts, configFileName): ResolveTargetOptions` reads `framework` and `importers` from our entry in `compilerOptions.plugins`. tsserver skips a global plugin that the project also lists, so the same entry serves VS Code, other editors and M7's `mf-tsc`.
  - The TypeScript plugin's host calls `resolveUcfImport` from `resolveModuleNameLiterals`, for `.ucf` files and their importers alike (one program). Errors become diagnostics at the import: `framework-in-block`, and a missing block naming both files.
- Deliverable: inside `<react>`, `import Card from '../Card.ucf'` gets Card's React types (spec 4.1).
- Test: area **Editor**, `packages/e2e/editor/blockImports.spec.ts`, through the real tsserver with our plugin (2.9's helper), on new fixtures in `packages/e2e/fixtures/components/editor/` (a subfolder, so M1's loops over `listComponents()` do not change):
  - `editor/Profile.ucf` imports `../Card.ucf` and `../Badge.ucf` in `<react>`: hover on `<Card` shows `{title: string}`; definition on `Card` lands in `Card.ucf`'s `<react>` block;
  - `editor/ImportErrors.ucf`: a missing `title` prop is an error on its line; importing `../imports/VueOnly.ucf` (new, `<vue>` only, in the shared `fixtures/components/imports/` folder) reports the missing block naming both files; a `with { framework: 'vue' }` inside `<react>` reports `framework-in-block`.

### 2.9 TypeScript plugin

- Build: `src/typescriptPlugin.ts`, subpath `./typescript-plugin`: Volar's `createLanguageServicePlugin` with `createUcfLanguagePlugin`, so tsserver serves `.ucf` files themselves (hybrid mode), then `resolveModuleNameLiterals` wrapped so `.ucf` specifiers go through `resolveUcfImport` and everything else goes to TypeScript. `getSemanticDiagnostics` adds the `resolveTarget` errors at the import, and the warning of spike 1 answer 2: TypeScript keeps one resolution per specifier and mode, so a second import of the same specifier with another framework in one file gets a warning naming the fix (one small re-export file per framework). A target with no types yet (`vue` until M4, `svelte` until M6) leaves the module unresolved, with a message naming the target, so a test can still see which rule won. Module format (spike 1, answer 4): ESM, with the factory exported as `'module.exports'`. The subpath joins `exports` (with the `source` condition). tsserver finds plugins with its own Node10 lookup, which ignores `exports`, so the package also ships a real `typescript-plugin/` folder (in `files`): its `index.js` imports the package's own `./typescript-plugin` export and re-exports it as `'module.exports'`.
- Deliverable: every TypeScript feature inside `<react>`, and the React types for `.ts` and `.tsx` importers, in any editor that loads tsserver plugins.
- Test: area **Editor**, `packages/e2e/editor/tsserver.spec.ts`, helper `packages/e2e/editor/lib/tsserver.ts` (`startTsserver({cwd, plugins})`, `request(command, args)`, `diagnostics(file)`). Starts the real `tsserver.js` of TypeScript 6.0.3 under `node --conditions=source`, with `--globalPlugins @multifront/language-tools/typescript-plugin`, on `fixtures/apps/imports/`:
  - every row of `expected.ts` with a `.ts` or `.tsx` importer: `react` rows resolve to `Card.ucf` (its React script), `vue` and `svelte` rows report their target, error rows report their code at the import;
  - in `App.tsx`: `quickinfo` on `<Card` shows its props, a wrong prop type is an error, `definition` lands in `Card.ucf` inside `<react>`;
  - `mixed.ts` (not covered by the line above): both imports get the type of the last one, and the second import has the warning naming the fix;
  - `no-default/bare.ts` reports `no-target`.
  - inside `Card.ucf`'s `<react>` (served by tsserver): completion after `$style.` lists `card`; hover on `title` shows `string`; definition on `$style.card` lands on `.card`; `editor/TypeError.ucf` (new fixture) reports its type error at its `.ucf` line and column.
  - one program: a `change` command on `Card.ucf` (no save) that renames a prop makes `App.tsx` report the old prop at once; `rename` on the prop in `Card.ucf` also edits `App.tsx`; `references` from `App.tsx` lists the use inside `<react>`.

### 2.10 The extension starts the server and loads the plugin

- Build:
  - `packages/vscode/src/extension.ts`: on the `ucf` language, starts the server with `@volar/vscode` and `vscode-languageclient` (exact pins), passing the tsdk of VS Code's built-in TypeScript extension.
  - `pnpm devx vsix` now also bundles with Vite's library mode (Rolldown, already at the root): `dist/extension.cjs` (`vscode` external) and `dist/server.cjs` (the language server and core). The TypeScript plugin goes to `packages/vscode/node_modules/multifront-typescript-plugin-pack/` (gitignored), because `contributes.typescriptServerPlugins` finds plugins in the extension's own `node_modules`, the way Vue's extension ships its plugin pack. `enableForWorkspaceTypeScriptVersions: true`.
  - The plugin entry has `"languages": ["ucf"]`, so VS Code sends open `.ucf` documents to tsserver (hybrid mode).
  - Open item this step settles: the server loads core, and core parses `<react>` with `oxc-parser`, which loads a native binding per platform. Either the bundle uses oxc's wasm binding, or `pnpm devx vsix` packs one `.vsix` per platform. The bundle test below proves the bundled server loads and answers.
- Deliverable: one `.vsix` with the grammar, the server and the TypeScript plugin. Nothing else to install.
- Test: area **Editor**, `packages/e2e/editor/bundle.spec.ts`. After the real `pnpm devx vsix`: the `Card.ucf` hover and the `invalid/` diagnostics of 2.6 run again against `dist/server.cjs` (no `source` condition), and the `App.tsx` quickinfo of 2.9 runs again with tsserver loading the plugin pack from `packages/vscode/node_modules`. This catches anything the bundle drops.

### 2.11 Real VS Code test harness

- Build: `packages/e2e/editor/vscode/`. `exit.spec.ts` starts a pinned VS Code with `@vscode/test-electron` (root devDependency, exact pin; `.vscode-test/` cache, gitignored), with `packages/vscode` as the development extension and `fixtures/apps/imports/` as the workspace. `suite.cjs` runs inside VS Code, checks with `node:assert`, and writes its results to a JSON file the spec reads. CI runs it under `xvfb-run`.
- Deliverable: a way to run any editor check in the real VS Code, for this milestone and the next ones.
- Test: the exit test below.

## Hands to later milestones

- **`resolveTarget(importer, attribute, options)`** in `packages/core/src/imports/resolveTarget.ts`, with `Importer`, `ResolveTargetOptions`, `TargetRule`, `TargetChoice`, `DEFAULT_IMPORTERS`, and the codes `framework-in-block`, `unknown-framework`, `no-target` in `DiagnosticCode`. **M3** extends it (the `targets` list, a non-literal value, an imported file without the block) and calls it from Vite, keeping the M2 signature, codes and order. **M4** sets `block: 'vue'` for imports inside `<vue>`, **M6** `block: 'svelte'`.
- **Imports fixture set** `packages/e2e/fixtures/apps/imports/` and `expected.ts`. **M3** runs the same rows through real Vite builds, so build and editor are proven to agree (spec section 10). **M4** adds the `.vue` importer rows to the tsserver run, **M6** the `.svelte` ones.
- **Options in the plugin entry**: `{"name": "@multifront/language-tools/typescript-plugin", "framework"?, "importers"?}` in `compilerOptions.plugins`, read by `readMultifrontOptions(ts, configFileName)`. **M7** `mf-tsc` reads the same entry. **M3** decides if the Vite plugin reads it as its default.
- **`EDITOR_BLOCK_KINDS`** in `packages/language-tools/src/blocks/index.ts`, and the types `EditorBlockKind`, `EditorFile`, `EditorOptions` (`{compiler?: VueCompiler}`), `EditorContext` (`{split, compiler, modules}`), `EditorStyleModule` (`{name, index, classes: StyleClass[] | undefined}`, `undefined` = could not be read, typed loosely), `StyleClass` (`{name, offset?}`, `offset` = where the name itself is written) (`src/types.ts`). **M4** fills vue's `types()` (`Card.ucf.vue.ts`) and `editor()`, **M6** svelte's (`Card.ucf.svelte.ts`). **M7** `mf-tsc` calls every row's `types()`.
- **react `types()`**, the `Card.ucf.react.tsx` script with typed `$style` and named modules, and **`getTypesScript(filename, source, target, options?: EditorOptions)`**. Pass `{compiler: loadVueCompiler(root)}`: without it only plain CSS modules are read. **M5** emits the React `.d.ts` with it; **M6** types `$style` in the Svelte script the same way (`declare const` lines from `ctx.modules`, the loose type for a module with `classes: undefined`).
- **`createUcfLanguagePlugin(options?: EditorOptions)`** (`src/languagePlugin.ts`; `compiler` is the first option, later steps add more) and **`resolveUcfImport(ts, literal, containingFile, options)`** (`src/resolve.ts`). **M4** and **M6** reuse them for `.vue` and `.svelte` importers; **M7** builds `mf-tsc` on both (M7's draft calls the resolver `resolveUcfModuleNames`: same thing).
- **`startServer()`** at `@multifront/language-tools/server` and the bin `multifront-language-server`, with `volar-service-css` and the `multifront` diagnostics service (`source: 'multifront'`). It never imports TypeScript: **M4** adds the Vue services and loads TypeScript from `initializationOptions.typescript.tsdk` for them, **M6** the Svelte ones, **M7** formatting and linting.
- **`@multifront/language-tools/typescript-plugin`**, loaded by tsserver from the real `typescript-plugin/` folder (2.9). It serves the React script as the `.ucf` file's own script, because Volar's tsserver plugin has no extra service scripts (spike 1). **M4** runs it beside Vue's own TypeScript plugin, and must first serve per-target scripts another way.
- **`loadVueCompiler(root)`** in core, and `compileStyle` in `VueCompiler`. **M4** and **M7** use them where there is no Vite; 2.9 passes its result as `EditorOptions.compiler` (the 2.6 server reads no `$style` types, so it passes none).
- **`stylePreprocessOptions(block)`** and **`moduleName(block)`** in core: the preprocessing and the module name the build and the editor share.
- **`generateGrammar(kinds): GrammarFile[]`** (`multifront-vscode/grammar`; root `source.ucf` first, then the copies served as `source.ucf.vue`, `source.ucf.svelte`, `source.ucf.vue.vue.*`; content scopes `meta.embedded.block.<tag>` and `meta.embedded.block.style.<languageId>`), the vendored grammars in `packages/vscode/syntaxes/vendor/`, and **`pnpm devx vsix`** (grammar, bundle, `.vsix`). Every later row gets highlighting from its `grammar` field. **M7** adds the Marketplace fields and publishing to the same command.
- **Editor test helpers** in `packages/e2e/editor/lib/`: `tokenizeUcf(path, grammars)` and `hasScope(token, scope)`, `startLanguageServer(workspace)` (a `@volar/test-utils` handle plus `stop()`), `startTsserver({cwd, plugins})`, and the VS Code harness in `packages/e2e/editor/vscode/`. **M4**, **M5**, **M6** and **M7** add their cases with them.
- **Fixtures**: `packages/e2e/fixtures/components/editor/` with `GrammarEdges.ucf` (every file there must stay splitter-valid: the 2.2 grammar test reads them all), `StyleModuleEdges.ucf` (with `values.css`), `LessModule.ucf`, `Profile.ucf`, `ImportErrors.ucf`, `TypeError.ucf`; `packages/e2e/fixtures/components/imports/VueOnly.ucf` (the shared imports folder M3, M4 and M6 add to).
- **Root devDependencies** (exact pins): `vscode-textmate` 9.3.2, `vscode-oniguruma` 2.0.1, `@volar/language-core` 2.4.28, `@volar/test-utils` 2.4.28, `@vscode/vsce`, `@vscode/test-electron`, `react`, `@types/react`.

## Exit test

`packages/e2e/editor/vscode/exit.spec.ts`, in the real VS Code, with the extension built by `pnpm devx vsix`, on `fixtures/apps/imports/`:

1. `Card.ucf` opens with language id `ucf`. `_workbench.captureSyntaxTokens` (the command VS Code's own colorize tests use) gives TSX scopes in `<react>`, SCSS scopes in `<style lang="scss">`, and Vue and Svelte scopes in `<vue>` and `<svelte>`.
2. In `<react>`: `vscode.executeCompletionItemProvider` after `$style.` lists `card`; `vscode.executeDefinitionProvider` on `$style.card` lands on `.card`. In `editor/Profile.ucf`, `vscode.executeHoverProvider` on `<Card` shows its props.
3. In `<style>` of `Panel.ucf`: hover on a property shows CSS docs.
4. `vscode.languages.getDiagnostics` has the type error of `editor/TypeError.ucf` on its line, and `duplicate-target` on `invalid/DuplicateReact.ucf`.
5. In `src/App.tsx`, served by VS Code's own tsserver with our plugin: hover on `<Card` shows the props from `Card.ucf`, and go to definition lands inside its `<react>` block.
6. An unsaved edit to a prop name in `Card.ucf` shows as an error in `App.tsx` before any save.

## Risks and open questions

- **One resolution per specifier per file.** TypeScript stores resolutions per (specifier, mode), so `./Card.ucf` imported as React and as Vue in one file gets one type, the last import's. Confirmed by spike 1; the fix is a re-export file per framework, and the plugin says so.
- **TypeScript 7 (native) has no JavaScript plugin API.** Our tsserver plugin works on TypeScript 6. If VS Code moves to the native TypeScript, importers lose `.ucf` types until a plugin API exists. Vue's tools have the same problem. Watch it; nothing to build now.
- **No Volar extra service scripts in tsserver.** Spike 1 confirmed it: the React code is the main script in M2, and M4 must solve per-target scripts before it adds Vue.
- **Grammar and splitter can disagree.** An embedded TSX rule (a string, a template literal, a JSX tag the TSX grammar misreads) can run past `</react>`. The 2.2 check against `splitBlocks` catches it on the fixtures. `'</react>'` in a string is a documented limitation in both (`invalid/ReactCloseInString.ucf`).
- **Style languages VS Code does not ship.** `source.sass`, `source.stylus` and `source.css.postcss` highlight only when the user has an extension for that language; otherwise the block shows as plain text.
- **Sync class names vs the build's class map.** A project PostCSS config that renames classes would make them differ. The 2.5 test guards the fixtures only.
- **Hybrid mode leans on tsserver plugins.** Every TypeScript feature in `.ucf` files needs a client that runs our plugin: VS Code does, Neovim through vtsls, WebStorm needs checking. The native TypeScript 7 has no plugin API yet; Vue's tools share that risk.
- **Editor and build options can drift**: the plugin entry in `tsconfig.json` vs the Vite plugin's options. Open for M3.
- **Open:** the extension's publisher id, needed before any Marketplace or Open VSX release (M7).

## Out of scope

- `<vue>` and `<svelte>` language features (M4, M6). In M2 they are highlighted only.
- Types for `.vue` and `.svelte` importers (M4, M6). The rules already pick those targets; the types scripts come later.
- `mf-tsc`, `mf-lint`, `mf-fmt`, and formatting or linting in the editor (M7).
- Language features for `less`, `sass`, `stylus` and `postcss` blocks (highlighting only).
- `style-compile-error` from `compileStyles` in the editor: the CSS service reports syntax errors itself.
- The Vite side of `resolveTarget()` and the attribute rewrite (M3); `.d.ts` build output (M5).
- Publishing to the VS Code Marketplace and Open VSX (M7).
- Testing other editors (WebStorm, Neovim). The subpaths and the bin are ready for them.
