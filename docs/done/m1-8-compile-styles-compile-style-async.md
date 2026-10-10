---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.8
---

# Milestone 1.8: compileStyles through compileStyleAsync

## Problem

Every non-Vue target (React in M3, Svelte in M6) and the library build (M5) needs each `<style>` block of a `.ucf`
file compiled exactly the way plugin-vue compiles a `.vue` style: same scoping, same CSS modules, a source map back
to the `.ucf` file, and compile errors placed in the `.ucf` file. Core has no style compiling yet. The
`VueCompiler` type also lives in `@multifront/vite` as a loose `(...args: never[]) => unknown` shape, which core
cannot call with real types.

Facts this plan rests on (`@vue/compiler-sfc` 3.5.42, `dist/compiler-sfc.cjs.js`, `@vitejs/plugin-vue` 6.0.8):

- plugin-vue's `transformStyle` (`plugin-vue/dist/index.mjs:1581-1595`) calls
  `compileStyleAsync({filename, id: 'data-v-' + id, isProd, source, scoped})`.
- `doCompileStyle` (`compiler-sfc.cjs.js:19952-20057`): the preprocessor (`processors` at :12129, keys
  `less | sass | scss | styl | stylus`) gets `options.inMap || options.map` and returns a merged map; PostCSS gets it
  as `map.prev`. Errors come back in `result.errors`, never thrown.
- Sass errors carry `span.start.offset` / `span.end.offset` relative to the block content (no `additionalData`) and
  `sassMessage` (one line). PostCSS `CssSyntaxError` carries `reason` and `input.offset`, relative to the source
  PostCSS read: the block content when nothing preprocessed it.
- With a preprocessor, PostCSS keeps a mapping it cannot follow through `map.prev`, under a second source name
  `basename(filename)` (`Card.ucf`). Those segments point at sass's output CSS, not at the `.ucf` file. Measured:
  Card.ucf block 0 has 1 of 4 such segments, Panel.ucf block 0 has 2 of 8, all closing `}` lines sass does not map.
  Plain CSS blocks have none.
- `SFCStyleCompileOptions.map` is `@deprecated use inMap instead` (`compiler-sfc.d.ts:242-245`): we pass `inMap`.
- `inMap` is typed `RawSourceMap` with `version: string`; `MagicString#generateMap()` returns `version: number`.

## Plan

1. **`packages/core/src/types.ts`**: add
   - `import type * as CompilerSfc from '@vue/compiler-sfc';`
     `export type VueCompiler = Pick<typeof CompilerSfc, 'compileStyleAsync' | 'parse' | 'MagicString'>;`
   - `export interface SourceMap {version: number; file?: string; sourceRoot?: string; sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string}`
   - `export interface CompiledStyle` exactly as in step 1.8 (`index`, `id`, `code`, `map: SourceMap | undefined`,
     `scoped`, `module`, `classes`, `errors`). In `types.ts`, not `styles.ts`: `context.ts` (1.9) shares it.
2. **`packages/core/src/ids.ts`** (new): `styleId(filename, index)` →
   `` `${filename}?ucf&type=style&index=${index}&lang.css` `` (spec 4.3). `CompiledStyle.id` needs it now; 1.9 adds
   `classMapId` to the same file.
3. **`packages/core/src/styles.ts`** (new):
   - `moduleName(block)` moves here from `blocks/style.ts:17-21` (exported); `blocks/style.ts` imports it, so the
     `duplicate-style-module` check and `CompiledStyle.module` read the attribute the same way.
   - `compileStyles(blocks, {id, filename, source, compiler, production}): Promise<CompiledStyle[]>`:
     `Promise.all`, one `compileStyleAsync` per block, results in block order.
   - Per block:
     - Input map: `new compiler.MagicString(source)`, `remove(0, block.contentStart)`,
       `remove(block.contentEnd, source.length)`, `generateMap({source: filename, hires: true, includeContent: true})`,
       passed as `inMap` with `version` as a string.
     - Options: `filename`, `id: 'data-v-' + id`, `isProd: production`, `scoped: 'scoped' in block.attrs`,
       `source: block.content`, `preprocessLang` when `lang` is one of `scss | sass | less | styl | stylus`,
       `modules: module !== undefined`, `modulesOptions.generateScopedName: (local) => `${local}_${id}_${block.index}``.
     - Map: keep only segments whose source is `filename`, `sources: [filename]`, `sourcesContent: [source]`,
       decoded and encoded with `@jridgewell/sourcemap-codec`. Drops the segments that point at sass's output.
     - Errors → `style-compile-error` through `createDiagnostic` (`diagnostics.ts:11`):
       - sass error (`span`): `contentStart + span.start.offset` to `contentStart + span.end.offset`, `sassMessage`;
       - PostCSS `CssSyntaxError` on a block nothing preprocessed: `contentStart + input.offset`
         (end `input.endOffset ?? offset`), `reason`;
       - anything else (a less or stylus error, a missing `sass`): the opening tag, first line of `err.message`.
       - Message: `<style lang="scss"> does not compile: expected "}".` (`<style>` with no `lang`), one line.
     - On error: `code` `''`, `map` and `classes` `undefined`, as the compiler returns them.
4. **`packages/core/src/index.ts`**: export `compileStyles`, `styleId`, types `CompiledStyle`, `SourceMap`,
   `VueCompiler`.
5. **`packages/core/package.json`**: optional peer `"@vue/compiler-sfc": "^3.5.0"`, devDependency
   `"@vue/compiler-sfc": "3.5.42"` (the allowed exception), dependency `"@jridgewell/sourcemap-codec": "1.6.0"`.
   Root devDependency `"@jridgewell/trace-mapping": "0.3.31"`. Added with `pnpm add`.
6. **`@multifront/vite`**: `src/types.ts` drops `VueCompiler`; `src/index.ts` and `src/vueCompiler.ts` import it from
   `@multifront/core`; `index.ts` re-exports `export type {VueCompiler} from '@multifront/core'`.
7. **Fixtures** in `packages/e2e/fixtures/components/invalid/`:
   - `ScssSyntaxError.ucf`: `<react>` with a default export, `<style lang="scss">` with `$size: large;` and the rule
     `.tag-#{$size {` (the interpolation's `}` is missing): sass points at that rule.
   - `CssSyntaxError.ucf`: `<react>`, `<style scoped>` with `.note { color: gray;` left open: PostCSS reports
     `Unclosed block` at `.note`.
   - Both are valid for the splitter and `checkBlocks`: rows in `split.spec.ts` `INVALID_CASES` (`errors: []`) and
     `__snapshots__/split/invalid/*.errors.json` (`[]`).

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`); they need only `@vue/compiler-sfc`, `sass` (root,
1.1) and `@jridgewell/trace-mapping` (added here). No new infra.

- **`packages/core/test/styles.spec.ts`** (new), real compiler, fixtures through `../../e2e/fixtures/index.ts`,
  `id = scopeId(name, source, true)`, `production: true`:
  - every valid fixture: one `CompiledStyle` per `<style>` block, in order, with `index`,
    `id === styleId(filename, index)`, `scoped`, `module`, `errors: []`;
  - file snapshot of every style block of every valid fixture, `test/__snapshots__/styles/<Name>.ucf.<index>.css`;
  - class maps: every key a class selector in the block content, every value a class selector in the CSS, equal to
    `<key>_<id>_<index>`; non-module blocks have `classes: undefined`;
  - maps: `sources` `[filename]`, `sourcesContent` `[source]`; plain CSS blocks: every segment has the same token at
    the generated and original position (a generated module class counts as its local name); SCSS blocks: every
    segment's original offset is inside `[contentStart, contentEnd)`;
  - `invalid/ScssSyntaxError.ucf` and `invalid/CssSyntaxError.ucf`: one `style-compile-error` each at a hand-written
    line and column, message names the tag on one line, `code === ''`, `map === undefined`.
- **`packages/vite/test/vueCompiler.spec.ts`**: `compileStyles` with `getVueCompiler([], root)` compiles
  `Badge.ucf`'s style; with typecheck, proves vite hands core a compiler core accepts.
- **`packages/core/test/split.spec.ts`**: the two `INVALID_CASES` rows.

## Docs

- Milestone doc: 1.8 says `inMap`, `CompiledStyle` in `types.ts`, `ids.ts` with `styleId`, the
  `@jridgewell/sourcemap-codec` dependency and the map filter, the `CssSyntaxError.ucf` fixture; 1.9 says `ids.ts`
  gains `classMapId`; "Hands to later milestones": Invalid components adds `CssSyntaxError`, root devDependencies pin
  `@jridgewell/trace-mapping` 0.3.31; `- Status: done` last in 1.8.
- `docs/spec.md` 3.3: the input map (maps point into the `.ucf` file) and module class names
  `<local>_<scopeId>_<index>`.
- No `architecture.md`, `plan.md` or `publicdocs/` change.

## Fuzzing

None: the step names no fuzz test (orchestrator decision).

## Out of scope

- `createBuildContext`, `fillContext` and `build` on the style kind, `classMapId` (1.9). The exit test (1.10).
- `less` and `stylus` fixtures (risk 8). Vite's `css.preprocessorOptions` reaching ours (risk 2).
- Any Vite plugin hook (M3).

## Found while building

- `packages/e2e/build/scope-id.spec.ts` (1.7) timed out about one full run in eight once this step's tests added
  load: when Vite's dep optimizer finished before `server.transformRequest()`, the request never resolved. The dev
  server there now runs with `optimizeDeps: {noDiscovery: true}` (no optimizer); 30 full runs green after, own commit.

## Decisions

- `styleId` lands in `ids.ts` now; 1.9 only adds `classMapId` (orchestrator).
- Map filter uses `@jridgewell/sourcemap-codec` 1.6.0, exact-pinned core dependency (orchestrator).
- `invalid/CssSyntaxError.ucf` added to cover the PostCSS error path (orchestrator).
- No fuzz test (orchestrator).
- `inMap` instead of the deprecated `map` (orchestrator).

## Done when

- `compileStyles()` compiles every `<style>` of every valid fixture into CSS, a map into the `.ucf` file (only `.ucf`
  segments) and, for modules, a class map with `<local>_<id>_<index>` names.
- Both syntax error fixtures give one `style-compile-error` at the hand-written `.ucf` line and column.
- `VueCompiler` lives in core, typed from `@vue/compiler-sfc`, re-exported by `@multifront/vite`.
- `pnpm devx check` green; milestone doc and spec 3.3 match what shipped; step 1.8 ends with `- Status: done`.
- Todo `git mv`'d into `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
