# Milestone 1: Splitter, block kinds + styles

## Goal

Turn a `.ucf` file into blocks we can trust, and compile its `<style>` blocks the way plugin-vue does.

When this milestone is done:

- `splitBlocks()` in `@multifront/core` splits any `.ucf` file into root blocks with exact offsets, and reports every structural error with a line and a column.
- The `BlockKind` contract and its registry exist in core, shared kinds first. `<style>` is the first full kind: `check`, `build` and grammar data. The three target kinds have `check` and grammar data; their `build` is filled by milestones 3, 4 and 6.
- `compileStyles()` compiles each `<style>` once with `compileStyleAsync`, with source maps back to the `.ucf` file and a class map for each CSS module.
- `scopeId()` gives the same `data-v-*` id plugin-vue gives, in dev and in production.
- `createBuildContext()` fills `ctx` (scope id, compiled CSS, `$style` class maps, style module ids) for the target kinds of later milestones.
- The private `packages/e2e` package exists with its four area folders and the first shared fixtures, so every later milestone only adds to it.

No Vite plugin work yet: serving modules and picking a target is milestone 3.

## Needs from earlier milestones

None: this is the first milestone. It builds on what the repo already has:

- `@multifront/core`: `Target = 'vue' | 'react' | 'svelte'`, `TARGETS`, `isTarget()` (`packages/core/src/index.ts`, `types.ts`).
- `@multifront/vite`: `multifront()`, `getVueCompiler(plugins, root)`, the `VueCompiler` and `MultifrontOptions` types (`packages/vite/src/`).
- Root tooling: `pnpm devx test | typecheck | lint | format | check`, the root `vitest.config.ts` project list, the root `tsconfig.json` references, `scripts/lib/env.mjs` `REGISTRY`.
- Pinned tools already installed: `vite` 8.2.2 (root), `@vitejs/plugin-vue` 6.0.8, `@vue/compiler-sfc` 3.5.42 and `vue` 3.5.42 (in `packages/vite`), `typescript` 6.0.3 and `playwright` 1.63.0 (root).

## Steps

### 1.1 The `packages/e2e` package and the Vue reference app

- Build:
  - New private package `packages/e2e` (`"name": "@multifront/e2e"`, `"private": true`, ESM). `dependencies`: `@multifront/core` and `@multifront/vite` as `workspace:*`.
  - Folders, one per test area: `build/`, `browser/`, `editor/`, `consumer/` (empty ones hold a `.gitkeep`), and `fixtures/components/`, `fixtures/apps/`.
  - `packages/e2e/vitest.config.ts`: project name `e2e`, `include: ['{build,browser,editor,consumer}/**/*.spec.ts']`, `resolve.conditions: ['source']` like the other packages, `testTimeout: 60_000`.
  - `packages/e2e/tsconfig.json` (check only, no `tsconfig.build.json`: the package is never built). It includes the four area folders, `fixtures/index.ts` and `*.config.ts`. Fixture apps are checked by their own builds, not by this config.
  - Add `'packages/e2e/vitest.config.ts'` to the root `vitest.config.ts` projects. No root `tsconfig.json` reference: `checkTree()` skips private packages.
  - Root devDependencies, exact-pinned to the same versions `@multifront/vite` carries: `@vitejs/plugin-vue` 6.0.8, `vue` 3.5.42. Also `sass` 1.104.0 (exact-pinned): Vite needs it to build the `<style scoped lang="scss">` block of `Reference.vue`. The e2e tests drive these tools for real.
  - `packages/e2e/fixtures/index.ts`, the fixture helpers every e2e test uses. This step adds the one its test calls (the `.ucf` helpers come in 1.2 with their first fixtures and callers):

    ```ts
    export function copyApp(name: string): Promise<string>;  // fresh copy of fixtures/apps/<name> under packages/e2e/.tmp/, returns its root
    ```

    `copyApp` copies into `packages/e2e/.tmp/<name>-<random>/`, inside the repo, so `vue` and other packages still resolve from the root `node_modules`. A failed copy removes its folder. Add `.tmp/` to `.gitignore`.
  - First app fixture `packages/e2e/fixtures/apps/vue-reference/`, a plain Vue app with no multifront in it:

    ```
    vue-reference/
      index.html
      vite.config.ts      plugins: [vue()]
      src/main.ts         createApp(Reference).mount('#app')
      src/env.d.ts        the *.vue module shim
      src/Reference.vue   <template>, <style scoped>, <style module>, <style scoped lang="scss">
    ```

    It is the yardstick: what plugin-vue does on its own, which our style pipeline must match.
- Deliverable: `pnpm devx test` runs the `e2e` project; `pnpm devx typecheck` passes with the new package; `copyApp()` exists.
- Test: area **Build**, `packages/e2e/build/vue-reference.spec.ts`. Runs a real `vite.build()` of `fixtures/apps/vue-reference` (with its own `vite.config.ts`, `build.write: false`, `minify: false`, `NODE_ENV=production` so the scope id is a real build's, not Vitest's `test` env) with the real plugin-vue. Checks the output has one JS chunk containing `__scopeId` with a `data-v-` value, and one CSS asset whose scoped rules carry that same `[data-v-…]` attribute. Fails without the package, its project entry or the app.
- Status: done

### 1.2 Block types, the registry and `splitBlocks` for valid files

- Build:
  - `packages/core/src/types.ts`: the shared types below (final shapes; `BlockKind` grows in 1.4, 1.6 and 1.9).

    ```ts
    export type BlockTag = 'style' | Target;           // 'style' | 'vue' | 'react' | 'svelte'
    export type BlockRole = 'shared' | 'target';

    export interface Block {
      type: BlockTag;
      attrs: Record<string, string | true>; // `scoped` → true, `lang="scss"` → 'scss'; a repeated name: last wins
      content: string;      // raw text between the opening and closing tag
      start: number;        // offset of the '<' of the opening tag
      end: number;          // offset just after the '>' of the closing tag
      contentStart: number; // offset just after the '>' of the opening tag
      contentEnd: number;   // offset of the '<' of the closing tag
      index: number;        // position among the blocks of the same type, in source order
    }

    export interface SplitResult {
      filename: string;
      source: string;
      blocks: Block[];                         // every root block, in source order
      styles: Block[];                         // the <style> blocks, in source order (styles[i].index === i)
      targets: Partial<Record<Target, Block>>; // the first block of each target
      errors: Diagnostic[];                    // splitter errors only (1.3)
    }
    ```

  - `packages/core/src/blocks/index.ts`: the registry, `BLOCK_KINDS: readonly BlockKind[]` in the order `style, vue, react, svelte` (shared first, then `TARGETS` order), and `getBlockKind(tag: BlockTag): BlockKind`. One file per kind: `blocks/style.ts` (`role: 'shared'`), `blocks/vue.ts`, `blocks/react.ts`, `blocks/svelte.ts` (`role: 'target'`). In this step a kind has only `tag` and `role`.
  - `packages/core/src/split.ts`: `splitBlocks(source: string, filename: string): SplitResult`. A hand-written scanner. Root tags come from `BLOCK_KINDS`, so a new kind adds a root tag with no splitter change. It reads an opening tag and its attributes (double quotes, single quotes, unquoted, bare), then takes the content as raw text up to the first `</tag` followed by `>` or whitespace (browser `<script>` rules). Between blocks only whitespace and HTML comments (`<!-- … -->`) are allowed.
  - Exports from `packages/core/src/index.ts`: `splitBlocks`, `BLOCK_KINDS`, `getBlockKind`, and the types above, plus `BlockKind`, `Diagnostic` and `DiagnosticCode` (which they name).
  - The `.ucf` fixture helpers, added to `packages/e2e/fixtures/index.ts` next to 1.1's `copyApp`:

    ```ts
    export const FIXTURES_DIR: string;                         // absolute path of packages/e2e/fixtures
    export function componentPath(name: string): string;       // 'Card.ucf' or 'invalid/DuplicateReact.ucf' → absolute path
    export function readComponent(name: string): {filename: string; source: string};
    export function listComponents(folder?: string): string[]; // *.ucf names in components/ (or a subfolder), sorted, with the folder prefix
    ```

  - Valid component fixtures in `packages/e2e/fixtures/components/`:

    | Fixture | Blocks | Covers |
    | --- | --- | --- |
    | `Card.ucf` | vue, react, svelte, `<style module lang="scss">` | the spec section 2 example, verbatim |
    | `Badge.ucf` | react, `<style scoped>` | one target, plain scoped CSS |
    | `Button.ucf` | vue, react, svelte, `<style scoped>`, `<style module='classes'>` | scoped plus a named module; single-quoted attribute |
    | `Panel.ucf` | vue, react, `<style scoped lang = scss>` (nesting, a variable), `<style>` | scoped SCSS plus a global block; unquoted attribute, spaces around `=` |
    | `Hello.ucf` | react only, no style | a file with no `<style>`; closing tag `</react >` |
    | `TsxEdges.ucf` | react, `<style scoped>` | `<>` fragments, `<T,>(x: T) => x`, `a < b`, `a<b && c>d`, a `'<react>'` string, `// <style>` comment, the escaped `'<\/react>'`, a `'</reactive>'` string, an HTML comment holding `<style>` between blocks |

- Deliverable: `splitBlocks()` returns the right blocks, attributes and offsets for every valid fixture.
- Test: `packages/core/test/split.spec.ts` (package's own test). For every name from `listComponents()` (read through a relative path to `packages/e2e/fixtures/components/`, no package dependency, so no workspace cycle):
  - `errors` is empty, and `source.slice(contentStart, contentEnd) === content` for every block.
  - The block table (`type`, `attrs`, `index`, offsets) matches a file snapshot, `test/__snapshots__/split/<Name>.ucf.json`.
  - Every `<react>` block content parses with the real TypeScript parser (`ts.createSourceFile(…, ScriptKind.TSX)`) with zero syntax errors. This proves the splitter never cut a TSX block early, `TsxEdges.ucf` included.
- Status: done

### 1.3 Splitter errors with exact locations

- Build:
  - The `Diagnostic` type in `packages/core/src/types.ts` (added in 1.2, because `SplitResult.errors` names it; until 1.3 `errors` is always empty):

    ```ts
    export type DiagnosticCode =
      | 'unknown-root-tag' | 'unclosed-block' | 'duplicate-target' | 'missing-target' | 'text-outside-block' // splitBlocks
      | 'react-no-default-export' | 'style-inside-target' | 'unknown-style-lang' | 'duplicate-style-module' // check (1.4)
      | 'style-compile-error';                                                                                // compileStyles (1.8)

    export interface Diagnostic {
      code: DiagnosticCode;
      severity: 'error' | 'warning'; // every milestone 1 code is an error
      message: string;               // one line, names the tag: "<react> appears more than once; keep one"
      filename: string;
      start: number;                 // offsets into the .ucf source
      end: number;
      line: number;                  // 1-based line of start
      column: number;                // 0-based column of start (the Rollup / Vite `loc` convention)
    }
    ```

  - `splitBlocks` fills `errors`, and keeps going after an error so the editor still gets every readable block:

    | Code | Where it points | What the splitter does next |
    | --- | --- | --- |
    | `unknown-root-tag` | the `<name` of the tag (the HTML name rule: `<react_old>` is one unknown tag) | self-closing: past its `/>`; else to its first `</name>` when that comes before the next root opening tag, otherwise to that root tag (so a later block is never swallowed) |
    | `unclosed-block` | the opening tag (also one that never ends cleanly: end of file, `/>`, a quote left open before `>` or a line break; then only `<name` when it has no `>` or a quote is left open) | the block is left out of `blocks`; the scan picks up again at the next root opening tag, so later blocks are still found |
    | `duplicate-target` | the second opening tag | both stay in `blocks`; `targets[tag]` is the first |
    | `missing-target` | `start = end = 0` | only when no target tag appears at all: an unclosed one already has its `unclosed-block` |
    | `text-outside-block` | the stray text run, up to the next root opening tag, trailing whitespace left out (an unclosed `<!--` starts one) | skips it |

  - Invalid fixtures in `packages/e2e/fixtures/components/invalid/`: `UnknownRootTag.ucf` (`<angular>` and `<react_old>`), `UnclosedReact.ucf`, `DuplicateReact.ucf`, `StylesOnly.ucf`, `TextOutsideBlock.ucf`, `ReactCloseInString.ucf`, `BrokenOpeningTags.ucf` (`<style scoped/>`, a quote left open, a `<style` with no `>`), `BrokenUnknownTags.ucf` (an unknown tag left open before a `<react>` block holding its closing tag, one with a quote left open, a self-closing one), `StrayClosingTag.ucf` (a doubled `</react>`), and `UnclosedComment.ucf` (a `<!--` with no `-->`). `ReactCloseInString.ucf` has `'</react>'` inside a TSX string: the block closes there and the rest is reported as `text-outside-block`. That is the documented limitation of spec 10, and the message tells the author to write `'<\/react>'`.
- Deliverable: every structural error of spec 3.2 comes back as a `Diagnostic` with exact offsets, line and column.
- Test: `packages/core/test/split.spec.ts`, a table of `{fixture, code, line, column}` written by hand for each invalid fixture, plus a file snapshot of the full `errors` array per fixture (`test/__snapshots__/split/invalid/<Name>.ucf.errors.json`). Also checks the blocks the splitter still returns (for example `DuplicateReact.ucf` keeps its `<style>` block).
- Status: done

### 1.4 Block checks: `check` per kind and `checkBlocks`

- Build:
  - `BlockKind` gets `check(block: Block, split: SplitResult): Diagnostic[]`.
  - `blocks/react.ts`: `react-no-default-export`. Parses the content with `oxc-parser` (`parseSync`, `lang: 'tsx'`) and looks for `export default …` or `export {X as default}`. Points at the opening `<react>` tag. If the block does not parse, it reports nothing: the TSX compiler and the TypeScript service report syntax errors with better messages.
  - `blocks/vue.ts` and `blocks/svelte.ts`: `style-inside-target`. Scans the block content one level down with the splitter's own tag scanner (`topLevelTags` in `src/scan.ts`, shared with `split.ts`; skipping comments and the raw text of `<script>` and `<style>`, counting nested `<template>` tags for vue and reading its other SFC-level tags as raw text like Vue's SFC parser, every non-void element for svelte, which leaves a `<style>` inside `<svelte:head>` or an element alone, as Svelte does) and reports a top-level `<style` tag. Points at that tag. Svelte `{#…}` logic blocks are not counted (risk 4).
  - `blocks/style.ts`: `unknown-style-lang` when `lang` is not one of `css`, `scss`, `sass`, `less`, `styl`, `stylus`, `postcss`. `duplicate-style-module` when two `<style>` blocks inject the same name (`module` → `$style`, `module="classes"` → `classes`). Points at the second block's opening tag.
  - `checkBlocks(split: SplitResult): Diagnostic[]` in `packages/core/src/blocks/index.ts`, beside the registry, returns `split.errors` plus every block's `getBlockKind(block.type).check(block, split)`, sorted by `start`. This is the one function hosts call.
  - `oxc-parser` becomes an exact-pinned `dependency` of `@multifront/core` (newest version older than the 30 day release age, `0.149.0`; milestone 3 reuses it for the scope transform).
  - Invalid fixtures: `invalid/ReactNoDefault.ucf` (named export only), `invalid/StyleInVue.ucf`, `invalid/StyleInSvelte.ucf`, `invalid/UnknownStyleLang.ucf` (`lang="foo"`, a bare `lang`), `invalid/DuplicateStyleModule.ucf` (bare `module` three ways: bare, `module=""`, `module="$style"`), `invalid/MixedErrors.ucf` (a block error before a splitter error, so `checkBlocks` must sort; a `export {X as "default"}`), `invalid/ReactSyntaxError.ucf` (a `<react>` block that does not parse and has no default export: no `react-no-default-export`).
- Deliverable: `checkBlocks()` reports every milestone 1 rule; valid fixtures report nothing.
- Test: `packages/core/test/check.spec.ts`. Every valid fixture gives `[]`. Each new invalid fixture gives exactly its code at the hand-written line and column. `Card.ucf` with `export {Card as default}` instead of `export default function` stays valid (a fixture copy, `ReactDefaultSpecifier.ucf`, added to `components/`).
- Status: done

### 1.5 Splitter fuzz test (generated real files)

- Build: `packages/core/test/split.fuzz.spec.ts`, built with the fuzzy-testing skill (its seeded runner and shrinker templates, no new library), on the shared runner `packages/core/test/fuzz.ts` (`fuzzSettings()`, `createRandom()`, `runFuzz()`, `describeFailure()`).
  - Input maker: pick a real fixture from `packages/e2e/fixtures/components/` (seeded), then apply 1 to 4 seeded mutations from a fixed list: shuffle the root blocks; insert whitespace or an HTML comment between blocks; change the quoting and spacing of an opening tag's attributes; move a TSX line from `TsxEdges.ucf` into another fixture's `<react>` block (recombine); duplicate a target block; delete one closing tag; truncate the file at a random offset (always applied last); insert `'</react>'` into a `<react>` string. A model of the file (its gaps and blocks, each block intact or not) knows where every block lands.
  - Rules, each proven by a negative control (a broken wrapper over the real `splitBlocks` output that the rule must catch), kept as permanent tests:
    1. `splitBlocks` and `checkBlocks` never throw.
    2. Every diagnostic has `0 <= start <= end <= source.length`, and its `line` / `column` are the real position of `start`.
    3. With no errors: blocks are sorted and do not overlap; `source.slice(start, contentStart)` is the opening tag, `source.slice(contentEnd, end)` is `</tag>`; the text between blocks is only whitespace and comments. So gaps plus blocks rebuild the exact file.
    4. The intact blocks before the first damaged one come back field for field, and any other intact block returned at its start keeps its content byte for byte. Their `<react>` content still parses with the real TypeScript parser with zero syntax errors.
    5. Known outcomes: with no damage (no deleted closing tag, no `'</react>'`, no truncation), the errors are exactly one `duplicate-target` per extra target copy and `checkBlocks` adds nothing; with damage, a duplicated target among the intact blocks still gives `duplicate-target`; a deleted closing tag that is the only damage, with no later `</tag` to close the block, gives `unclosed-block` at that block. A later closing tag of the same name closes the block legally (browser `<script>` rule), so "any deleted closing tag gives an error" would not be sound.
  - A coverage test checks, on the default seed, that every mutation applies and every rule's case is reached.
  - Seed and run count from two new env vars, `MULTIFRONT_FUZZ_SEED` (default: `2026`) and `MULTIFRONT_FUZZ_RUNS` (default 500), added to `REGISTRY` in `scripts/lib/env.mjs` (scope `dev`) and to `.env.sample`.
  - Every failure found is shrunk and saved as a new fixture under `packages/e2e/fixtures/components/fuzz/`, with a row in the table test of 1.3 or 1.4.
- Deliverable: a replayable fuzz run over generated real files; any failure prints its seed and a replay line (`MULTIFRONT_FUZZ_SEED=… MULTIFRONT_FUZZ_RUNS=… pnpm devx test packages/core/test/split.fuzz.spec.ts`) in the assertion message.
- Test: the fuzz spec itself, 500 runs in `pnpm devx test`. It would fail on the splitter bugs it is built to catch (an off-by-one offset, a block cut early, a thrown error on truncated input), as each negative control shows. While building it, 100,000 runs over five more seeds found no failure, so `fuzz/` holds no fixture yet.
- Status: done

### 1.6 Grammar data per kind

- Build:
  - `BlockKind` gets `grammar: BlockGrammar`:

    ```ts
    export interface GrammarScope { scopeName: string; languageId: string }
    export interface BlockGrammar extends GrammarScope {
      byLang?: Record<string, GrammarScope>; // picked by the block's lang attribute
    }
    ```

  - Values: `style` → `source.css` / `css`, with `byLang` `scss` → `source.css.scss` / `scss`, `sass` → `source.sass` / `sass`, `less` → `source.css.less` / `less`, `styl` and `stylus` → `source.stylus` / `stylus`, `postcss` → `source.css.postcss` / `postcss`. `react` → `source.tsx` / `typescriptreact`. `vue` → `source.vue` / `vue`. `svelte` → `source.svelte` / `svelte`.
  - Root devDependency `shiki`, exact-pinned (it ships real TextMate grammars for every one of these languages).
- Deliverable: the registry holds everything milestone 2 needs to generate the `.ucf` TextMate grammar.
- Test: area **Editor**, `packages/e2e/editor/grammar-scopes.spec.ts`. Loads shiki's bundled grammars. Checks every `scopeName` in `BLOCK_KINDS` (and in each `byLang`) is the `scopeName` of a real grammar. Then, for every block of every valid fixture, tokenizes `block.content` with the grammar picked by its kind and `lang`, and checks it tokenizes with no fallback to plain text. A typo in a scope name fails it.

### 1.7 `scopeId` with the plugin-vue scheme

- Build: `packages/core/src/scopeId.ts`: `scopeId(relativePath: string, source: string, production: boolean): string`. Returns the first 8 hex chars of `sha256(relativePath + (production ? source : ''))`, like plugin-vue's default `getHash`. `relativePath` is the file path relative to the Vite root, with `/` separators on every OS. For a `.ucf` file, `source` is the whole `.ucf` source. Exported from core.
- Deliverable: one scope id function, used later for every target.
- Test: area **Build**, `packages/e2e/build/scope-id.spec.ts`, against the real plugin-vue with no `componentIdGenerator` set:
  - production: a real `vite.build()` of `fixtures/apps/vue-reference`; the `data-v-` value in the output equals `scopeId('src/Reference.vue', <file source>, true)`;
  - development: a real `createServer()` of the same app and `server.transformRequest('/src/Reference.vue')`; the `data-v-` value equals `scopeId('src/Reference.vue', <file source>, false)`.

### 1.8 `compileStyles` through `compileStyleAsync`

- Build:
  - `VueCompiler` moves to `packages/core/src/types.ts`, typed from the real package: `Pick<typeof import('@vue/compiler-sfc'), 'compileStyleAsync' | 'parse' | 'MagicString'>` (type-only import). `@multifront/vite` drops its own copy and re-exports core's (`export type {VueCompiler} from '@multifront/core'`), so `getVueCompiler()` returns a value core accepts.
  - `@multifront/core` gets `peerDependencies: {"@vue/compiler-sfc": "^3.5.0"}` (optional, like vite's) and the devDependency `"@vue/compiler-sfc": "3.5.42"` that satisfies it (the allowed exception). Root devDependency: `@jridgewell/trace-mapping` (exact-pinned, to read maps in tests); `sass` is already one (1.1).
  - `packages/core/src/styles.ts`:

    ```ts
    export function compileStyles(blocks: Block[], options: {
      id: string;            // the scope id, without 'data-v-'
      filename: string;      // absolute .ucf path
      source: string;        // the whole .ucf source, for the input map
      compiler: VueCompiler;
      production: boolean;
    }): Promise<CompiledStyle[]>;

    export interface CompiledStyle {
      index: number;                          // the block's index among the <style> blocks
      id: string;                             // module id, see styleId() in 1.9
      code: string;                           // plain CSS
      map: SourceMap | undefined;             // back to the .ucf file
      scoped: boolean;
      module: string | undefined;             // injection name: '$style' or the module="name" value
      classes: Record<string, string> | undefined; // CSS module class map, local → generated
      errors: Diagnostic[];                   // 'style-compile-error', positioned in the .ucf file
    }
    ```

  - One `compileStyleAsync` call per block, with the same options plugin-vue passes (`filename`, `id: 'data-v-' + id`, `isProd: production`, `scoped`, `source`) plus `preprocessLang` from `lang` (none for `css` and `postcss`), `modules` when the block has `module`, and `map`: an input map from `compiler.MagicString` over the `.ucf` source, so the output map points into the `.ucf` file, not the block.
  - CSS module class names are deterministic: `modulesOptions.generateScopedName` is `<local>_<scopeId>_<index>` (for example `card_1a2b3c4d_0`).
  - `SourceMap` type in `types.ts`: `{version: number; file?: string; sourceRoot?: string; sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string}`.
  - Fixture `invalid/ScssSyntaxError.ucf` (a missing `}` in a `lang="scss"` block).
- Deliverable: every `<style>` block compiles once into CSS, a map into the `.ucf` file and, for modules, a class map.
- Test: `packages/core/test/styles.spec.ts`, with the real `@vue/compiler-sfc` and the real `sass`:
  - style snapshots per fixture block as file snapshots, `test/__snapshots__/styles/<Name>.ucf.<index>.css`: scoped (`Badge.ucf`), module (`Card.ucf`), named module (`Button.ucf`), scss (`Card.ucf`, `Panel.ucf`), global (`Panel.ucf`);
  - every key of a class map is a class selector in the block source, and every value is a class selector in the CSS;
  - maps: for plain CSS blocks, every mapped segment (read with `@jridgewell/trace-mapping`) points at the same text in the `.ucf` file; for SCSS blocks, every segment lands inside the block's content range;
  - `ScssSyntaxError.ucf` gives one `style-compile-error` at the `.ucf` line and column of the broken rule.

### 1.9 Build context, the `<style>` kind's `build`, `$style` class maps

- Build:
  - `BlockKind` gets its last two milestone 1 members:

    ```ts
    export interface BlockKind {
      tag: BlockTag;
      role: BlockRole;
      grammar: BlockGrammar;
      check(block: Block, split: SplitResult): Diagnostic[];
      fillContext?(blocks: Block[], ctx: BuildContext): Promise<void>; // shared kinds only; runs before any build
      build?(block: Block, ctx: BuildContext): VirtualFile;           // style now; react in M3, vue in M4, svelte in M6
    }

    export interface VirtualFile {
      ext: '.tsx' | '.vue' | '.svelte' | '.css' | '.scss' | '.ts';
      code: string;
      map: SourceMap | undefined; // back to the block in the .ucf file
    }
    ```

    `types` and `editor` are not here: they are the language-tools half of each kind (milestone 2), so `@vue/language-core` and `svelte2tsx` never reach a build.
  - `packages/core/src/context.ts`:

    ```ts
    export interface BuildContextOptions { root: string; compiler: VueCompiler; production: boolean }

    export interface BuildContext {
      filename: string;                     // absolute .ucf path
      split: SplitResult;                   // every block; the vue build (M4) needs all of them
      relativePath: string;                 // from options.root, '/' separators: the scopeId input
      source: string;
      production: boolean;
      compiler: VueCompiler;
      scopeId: string;                      // 8 hex chars; the attribute is `data-v-${scopeId}`
      hasScoped: boolean;                   // some <style scoped> exists: target builds stamp attributes only then
      styles: CompiledStyle[];              // one per <style> block, in source order
      modules: Record<string, StyleModule>; // '$style' and named modules, by injection name
    }

    export interface StyleModule {
      name: string;                    // '$style' or the module="name" value
      index: number;                   // the <style> block it comes from
      id: string;                      // classMapId(filename, index)
      classes: Record<string, string>; // local → generated class name
    }

    export function createBuildContext(split: SplitResult, options: BuildContextOptions): Promise<BuildContext>;
    ```

    `createBuildContext` computes `scopeId(relativePath, source, production)`, then calls `fillContext` of every `shared` kind in registry order. It does not run checks: hosts call `checkBlocks` first.
  - `blocks/style.ts`: `fillContext` calls `compileStyles(split.styles, …)` and fills `ctx.styles`, `ctx.modules` and `ctx.hasScoped`. `build(block, ctx)` returns `{ext: '.css', code, map}` from `ctx.styles[block.index]`.
  - `packages/core/src/ids.ts`, the style module ids of spec 4.3:

    ```ts
    export function styleId(filename: string, index: number): string;    // `${filename}?ucf&type=style&index=${index}&lang.css`
    export function classMapId(filename: string, index: number): string; // `${filename}?ucf&type=style&index=${index}&module&lang.js`
    ```

    The CSS id never names a framework, so React and Svelte share it (the Vue target uses plugin-vue's own style modules, spec 4.3). The class map id is new: spec 3.3 says the class map is a virtual JS module but 4.3 gives it no id.
  - Exports from core: `createBuildContext`, `compileStyles`, `scopeId`, `checkBlocks`, `styleId`, `classMapId`, and the types `BlockKind`, `BlockGrammar`, `GrammarScope`, `VirtualFile`, `SourceMap`, `BuildContext`, `BuildContextOptions`, `CompiledStyle`, `StyleModule`, `VueCompiler`, `Diagnostic`, `DiagnosticCode`.
  - Update the `BlockKind` snippet in `docs/architecture.md` to this shape (`fillContext`, `index`, the core and language-tools halves).
- Deliverable: one call gives every later target everything the shared styles provide.
- Test: `packages/core/test/context.spec.ts`. For every valid fixture: `createBuildContext` with the real compiler; `ctx.scopeId` equals `scopeId()` of the same inputs; `ctx.styles[i].id === styleId(filename, i)`; `Card.ucf` has `ctx.modules.$style` with a `card` class; `Button.ucf` has `ctx.modules.classes` and no `$style`; `Hello.ucf` has no styles and `hasScoped === false`; the style kind's `build` returns the same CSS as `ctx.styles[i].code` with `ext: '.css'`.

### 1.10 Style parity with plugin-vue (the exit test)

- Build: `packages/e2e/build/style-parity.spec.ts`, the exit test below. It generates real files from the fixtures and runs real Vite with the real plugin-vue.
- Deliverable: proof that the CSS milestones 3 and 6 will ship for React and Svelte is the CSS plugin-vue ships for Vue.
- Test: see the exit test.

## Hands to later milestones

| Name | Exact shape or location | Used by |
| --- | --- | --- |
| `splitBlocks(source, filename): SplitResult` | `@multifront/core` | M2 (language plugin), M3 (Vite plugin, cached per file), M4, M6, M7 (`mf-fmt`, `mf-lint`) |
| `checkBlocks(split): Diagnostic[]` | `@multifront/core` | M2 (server diagnostics), M3 (Vite build errors), M7 (`mf-tsc`) |
| `Block`, `BlockTag`, `BlockRole`, `SplitResult` | types in 1.2 | M2 to M7 |
| `Diagnostic`, `DiagnosticCode` | type in 1.3. Later milestones add codes to the same union (for example M3's `framework` attribute error) | M2, M3, M4, M6, M7 |
| `BlockKind`, `BLOCK_KINDS`, `getBlockKind(tag)` | `packages/core/src/blocks/index.ts`, order `style, vue, react, svelte` | M2 (grammar generation, the language-tools registry with the same tags), M3, M4, M6 (fill `build`) |
| Empty `build` slots | `blocks/react.ts` (M3), `blocks/vue.ts` (M4), `blocks/svelte.ts` (M6). Once M6 lands, `build` may become required | M3, M4, M6 |
| `BlockGrammar`, `GrammarScope` | `kind.grammar` with `scopeName`, `languageId`, `byLang` (1.6) | M2 (TextMate grammar and `embeddedLanguages` of `packages/vscode`) |
| `VirtualFile`, `SourceMap` | types in 1.8 and 1.9 | M2 (language-tools `types` / `editor` return `VirtualFile`), M3, M4, M6 |
| `scopeId(relativePath, source, production)` | `@multifront/core`; `relativePath` from the Vite root with `/`; `source` is the whole `.ucf` source | M3, M6 (stamping `data-v-*`), M4 (plugin-vue `features.componentIdGenerator` must call it with the `.ucf` path and `.ucf` source, ignoring the SFC code plugin-vue passes) |
| `compileStyles(blocks, options): Promise<CompiledStyle[]>` | `@multifront/core`, 1.8 | through `createBuildContext` in M3, M5, M6; M2 may call it for `$style` class names |
| `createBuildContext(split, {root, compiler, production}): Promise<BuildContext>` | `@multifront/core`, 1.9 (`ctx` with `split`, `source`, `production`, `scopeId`, `hasScoped`, `styles`, `modules`) | M3 (React build), M5 (CSS files), M6 (Svelte build) |
| `ctx.modules[name].classes` | local → generated class names per `$style` / named module | M2 (`$style` type in `Card.ucf.react.tsx`), M3 (class map module), M6 |
| `styleId(filename, index)`, `classMapId(filename, index)` | `@multifront/core`, `src/ids.ts` | M3 (resolve and load the style and class map virtual modules), M5, M6 |
| `VueCompiler` | `Pick<typeof import('@vue/compiler-sfc'), 'compileStyleAsync' \| 'parse' \| 'MagicString'>`, owned by core, re-exported by `@multifront/vite` | M3, M4 (pass `multifront().api.vueCompiler`) |
| `oxc-parser` | exact-pinned dependency of `@multifront/core` (`0.149.0`) | M3 (scope transform) |
| `packages/e2e` package | `@multifront/e2e`, private, vitest project `e2e`, folders `build/ browser/ editor/ consumer/ fixtures/` | M2 to M7 |
| Fixture helpers | `packages/e2e/fixtures/index.ts`: `copyApp()` (1.1, temp copies in `packages/e2e/.tmp/`), `FIXTURES_DIR`, `componentPath()`, `readComponent()`, `listComponents()` (1.2) | M2 to M7 |
| Valid components | `fixtures/components/`: `Card.ucf`, `Badge.ucf`, `Button.ucf`, `Panel.ucf`, `Hello.ucf`, `TsxEdges.ucf`, `ReactDefaultSpecifier.ucf` | M2 (React virtual script, `$style` types), M3 (React builds), M4 (`<vue>` blocks of Card, Button, Panel), M5 (library build input), M6 (`<svelte>` blocks of Card, Button) |
| Invalid components | `fixtures/components/invalid/`: `UnknownRootTag`, `UnclosedReact`, `DuplicateReact`, `StylesOnly`, `TextOutsideBlock`, `ReactCloseInString`, `BrokenOpeningTags`, `BrokenUnknownTags`, `StrayClosingTag`, `UnclosedComment`, `ReactNoDefault`, `StyleInVue`, `StyleInSvelte`, `UnknownStyleLang`, `DuplicateStyleModule`, `MixedErrors`, `ReactSyntaxError`, `ScssSyntaxError` (all `.ucf`) | M2 (the server shows the same diagnostics at the same places), M3 (build errors) |
| App fixture | `fixtures/apps/vue-reference/` (plain Vue, plugin-vue only) | M4 (reference for the Vue target), browser parity tests |
| Fuzz knobs | env vars `MULTIFRONT_FUZZ_SEED`, `MULTIFRONT_FUZZ_RUNS` in `scripts/lib/env.mjs` | M3 (scope transform fuzz), M7 (position map fuzz) |
| Root devDependencies | `@vitejs/plugin-vue` 6.0.8, `vue` 3.5.42, `sass` 1.104.0, `shiki`, `@jridgewell/trace-mapping` (exact pins) | M2 to M7 |
| Commands | `pnpm devx test` runs the `e2e` project; one area: `pnpm devx test packages/e2e/build` | everyone |

## Exit test

`packages/e2e/build/style-parity.spec.ts` (area **Build**), over every name in `listComponents()`:

1. `splitBlocks` and `checkBlocks` report nothing.
2. `createBuildContext(split, {root, compiler: require('vue/compiler-sfc'), production: true})`, where `root` is a fresh `copyApp('vue-reference')` and the fixture is copied to `src/<Name>.ucf` in it.
3. Into the same copy, write `src/<Name>.vue`: `<template><div /></template>` plus the fixture's non-module `<style>` blocks, copied verbatim (`source.slice(block.start, block.end)`). Write `src/<Name>.ours.css`: our compiled CSS of the same blocks, from each style kind `build()`.
4. Two real `vite.build()` runs of that copy (`cssMinify: false`, `write: false`):
   - one whose entry imports only `<Name>.vue`, with plugin-vue's `features.componentIdGenerator` returning `ctx.scopeId`;
   - one whose entry imports only `<Name>.ours.css`.
5. The two emitted CSS assets are equal. Both passed the same Vite CSS steps, so any difference is ours.
6. For module blocks (plugin-vue hands those to Vite's own CSS modules, so names differ by design): every key of `ctx.modules[name].classes` is a class selector in the block source, and every value is a class selector in our CSS.
7. `pnpm devx check` is green.

## Risks and open questions

1. **CSS module class names differ between targets.** Ours are `<local>_<scopeId>_<index>`. For the Vue target, plugin-vue sends module blocks to Vite's CSS modules, which name classes its own way. Rendering is the same, names are not. Milestone 4 can decide whether to set Vite's `css.modules.generateScopedName` to match.
2. **SCSS through two preprocessors.** plugin-vue lets Vite's CSS step run `sass` first; we run it through `compileStyleAsync`'s `preprocessLang`. Output can differ, and Vite's `css.preprocessorOptions` (`additionalData`, load paths) do not reach ours. The exit test shows any difference. Fallback if it does: serve `lang.scss` ids and scope after Vite's preprocessing, which changes spec 4.3.
3. **`</react>` inside a TSX string** closes the block (spec 10, documented). The error message gives the fix (`'<\/react>'`).
4. **`style-inside-target` uses our scanner**, not Vue's or Svelte's parser. Exotic templates might fool it. Known misses, all in Svelte: a `<style` inside a `{…}` text expression is reported; a `<style>` inside a `{#…}` logic block is reported (Svelte leaves it in the markup); an omitted end tag (`<ul><li>a<li>b</ul>`) leaves the depth off by one, so a later top-level `<style>` is missed. If they matter, the check can use `compiler.parse` instead, once `check` gets the compiler, or carry HTML's table of omitted end tags.
5. **Test tools at the root.** AGENTS.md keeps devDependencies at the root, so plugin-vue, vue, sass and shiki go there even though only e2e and core tests use them. If the reviewer prefers, a private package could carry its own; the rule does not say.
6. **Core tests read e2e fixtures by relative path.** A `workspace:*` dependency on `@multifront/e2e` would make a cycle (e2e depends on core).
7. **A `<react>` block that does not parse** gets no `react-no-default-export`. The real compiler reports the syntax error instead.
8. **`less` and `stylus`** pass the lang check but are not compiled in milestone 1 tests (no `less` / `stylus` install). Spec 2 lists them, so a later milestone or a follow-up todo should add one fixture each.

## Out of scope

- Any Vite plugin hook: resolving `.ucf` imports, serving style and class map modules, `resolveTarget()`, the attribute rewrite (milestone 3).
- `build` for `react`, `vue` and `svelte` (milestones 3, 4, 6).
- `types` and `editor` halves, `packages/language-tools`, `packages/vscode` (milestone 2 and later).
- HMR, SSR and the browser area (milestone 3 onward).
- `v-bind()` in CSS for React and Svelte, `<style src="…">`, target-only `<style>` (open questions in the spec).
- The library build and the consumer area (milestone 5).
