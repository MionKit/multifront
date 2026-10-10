---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.9
---

# Milestone 1.9: build context, the `<style>` kind's `build`, `$style` class maps

## Problem

Later targets (React M3, library build M5, Svelte M6) and the editor (M2, one test) need one call that turns a split
`.ucf` file into everything the shared `<style>` blocks provide: the scope id, the compiled CSS of each block with its
module id, and a class map per CSS module with its own module id. Today core has the pieces (`scopeId`, `compileStyles`,
`styleId`) but no `BuildContext`, no `fillContext` / `build` on `BlockKind`, no `VirtualFile`, no `classMapId`.

Facts this plan rests on (current `main`):

- `BlockKind` (`packages/core/src/types.ts:43-48`) has `tag`, `role`, `grammar`, `check`. `CompiledStyle`
  (`types.ts:89-98`) already lives in `types.ts`, waiting for 1.9 to share it.
- `styleKind` (`packages/core/src/blocks/style.ts:32-37`) has only `check`; it already imports `moduleName` from
  `styles.ts`. Target kinds (`blocks/react.ts`, `vue.ts`, `svelte.ts`) get no new member here.
- `compileStyles(blocks, {id, filename, source, compiler, production})` (`packages/core/src/styles.ts:35-37`) never
  rejects; a block with errors has `code: ''`, `map` and `classes` `undefined`, `errors` filled.
- `styleId` is in `packages/core/src/ids.ts:2-4`. `scopeId(relativePath, source, production)` in `src/scopeId.ts:4`.
- plugin-vue gets the scope id path as `normalizePath(path.relative(root, filename))`: we do the same with
  `node:path` `relative` and `/` separators (core already uses `node:crypto` and `node:url`, so Node built-ins are fine).
- plugin-vue 6.0.8 `genStyleCode` merges module names block by block with
  `Object.assign(cssModulesMap ||= {}, nameMap)` (`dist/index.mjs:1518`), so a later block with the same name wins.
- AGENTS.md: "Shared types live in the package's `types.ts`". `BuildContext`, `BuildContextOptions`, `StyleModule`
  and `VirtualFile` are named by `BlockKind` (types.ts), `blocks/style.ts` and `context.ts`: they go in `types.ts`,
  not `context.ts` as the step text says. Step text updated to match.

## Plan

1. **`packages/core/src/types.ts`**:
   - `BlockKind` gains
     `fillContext?(blocks: Block[], ctx: BuildContext): Promise<void>; // shared kinds only; runs before any build`
     and `build?(block: Block, ctx: BuildContext): VirtualFile; // style now; react in M3, vue in M4, svelte in M6`.
   - New, exact step shapes: `VirtualFile {ext: '.tsx' | '.vue' | '.svelte' | '.css' | '.scss' | '.ts'; code: string;
     map: SourceMap | undefined}`, `BuildContextOptions {root: string; compiler: VueCompiler; production: boolean}`,
     `BuildContext {filename; split; relativePath; source; production; compiler; scopeId; hasScoped; styles:
     CompiledStyle[]; modules: Record<string, StyleModule>}`, `StyleModule {name; index; id; classes: Record<string,
     string>}`, with the step's one-line comments.
2. **`packages/core/src/ids.ts`**: add `classMapId(filename, index)` →
   `` `${filename}?ucf&type=style&index=${index}&module&lang.js` ``.
3. **`packages/core/src/context.ts`** (new):
   `createBuildContext(split, {root, compiler, production}): Promise<BuildContext>`:
   - `relativePath = relative(root, split.filename).split(sep).join('/')`;
   - `ctx = {filename: split.filename, split, relativePath, source: split.source, production, compiler,
     scopeId: scopeId(relativePath, split.source, production), hasScoped: false, styles: [], modules: {}}`;
   - for each kind of `BLOCK_KINDS` with `role === 'shared'`, in registry order, one after another:
     `await kind.fillContext?.(split.blocks.filter((block) => block.type === kind.tag), ctx)`;
   - no checks run (hosts call `checkBlocks` first), never rejects (compileStyles never does).
4. **`packages/core/src/blocks/style.ts`**:
   - `fillContext(blocks, ctx)`: `ctx.styles = await compileStyles(blocks, {id: ctx.scopeId, filename: ctx.filename,
     source: ctx.source, compiler: ctx.compiler, production: ctx.production})`;
     `ctx.hasScoped = ctx.styles.some((style) => style.scoped)`; for each style with a `module` name, in order:
     `ctx.modules[name] = {name, index, id: classMapId(ctx.filename, index), classes: style.classes ?? {}}`.
     - A duplicate module name (already a `duplicate-style-module` from `checkBlocks`): the last block wins, as in
       plugin-vue.
     - A module block that does not compile: its `StyleModule` stays, with `classes: {}`, so `$style` still resolves
       and the one error shown is the block's `style-compile-error` in `ctx.styles[index].errors`.
   - `build(block, ctx)`: `const {code, map} = ctx.styles[block.index]!; return {ext: '.css', code, map}`.
5. **`packages/core/src/index.ts`**: add `createBuildContext`, `classMapId`, types `BuildContext`,
   `BuildContextOptions`, `StyleModule`, `VirtualFile`. The rest of the step's list (`compileStyles`, `scopeId`,
   `checkBlocks`, `styleId`, `BlockKind`, `BlockGrammar`, `GrammarScope`, `SourceMap`, `CompiledStyle`, `VueCompiler`,
   `Diagnostic`, `DiagnosticCode`) is already exported; checked, not re-added.

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`, step "Test"); they need only `@vue/compiler-sfc`
(core devDependency) and `sass` (root), both already installed. No new infra.

- **`packages/core/test/context.spec.ts`** (new), real `@vue/compiler-sfc` through `createRequire`, fixtures through
  `../../e2e/fixtures/index.ts` (relative path, as `styles.spec.ts` does), `root` = the fixtures folder, so
  `relativePath` is `components/<Name>.ucf` (a real subfolder, proves `/` separators and `root` reach the id):
  - covers every name in `listComponents()` (a hand-written table of `hasScoped` and module names per fixture, keys
    equal `listComponents()`, like `styles.spec.ts`);
  - per valid fixture, `production: true`: `ctx.filename`, `ctx.split`, `ctx.source`, `ctx.relativePath ===
    'components/<Name>.ucf'`; `ctx.scopeId === scopeId(relativePath, source, true)`; `ctx.styles` deep-equals
    `compileStyles(split.styles, …)` called directly with the same inputs; `ctx.styles[i].id === styleId(filename, i)`;
    `hasScoped` from the table; for every style kind block, `getBlockKind('style').build!(block, ctx)` equals
    `{ext: '.css', code: ctx.styles[i].code, map: ctx.styles[i].map}`;
  - `ctx.modules`: `Card.ucf` has `$style` = `{name: '$style', index: 0, id: classMapId(filename, 0), classes}` with a
    `card` key and `classes` equal to `ctx.styles[0].classes`; `Button.ucf` has `classes` (index 1) and no `$style`;
    `Hello.ucf` has `styles: []`, `modules: {}`, `hasScoped: false`;
  - `production: false` on `Card.ucf`: `ctx.scopeId === scopeId(relativePath, source, false)` and differs from the
    production id (the flag reaches `scopeId`);
  - `Card.ucf`'s `$style` id is `` `${filename}?ucf&type=style&index=0&module&lang.js` `` (pins `classMapId` on real output);
  - `invalid/ScssSyntaxError.ucf` (module block that fails): resolves, one `style-compile-error` in
    `ctx.styles[0].errors`, `ctx.modules.$style.classes` is `{}`, `build` gives `code: ''`, `map: undefined`;
  - `invalid/DuplicateStyleModule.ucf`: `ctx.modules.$style.index === 4`, the last duplicate (last block wins).
- Each test fails without the step (no `createBuildContext`, `classMapId`, `fillContext` or `build`).
- The `/` join in `relativePath` is a no-op on POSIX, and CI runs only Linux: no test covers it. It stays, because
  plugin-vue normalizes the same way (`normalizePath`) and scope ids must match on Windows.

## Docs

- Milestone doc 1.9: the types sit in `types.ts`, `context.ts` holds `createBuildContext`; the duplicate-module (last
  wins, plugin-vue `dist/index.mjs:1518`) and failed-module rules; `- Status: done` as the last line. "Hands to later
  milestones": `createBuildContext` row adds `StyleModule` and `filename` / `relativePath` / `compiler`;
  `VirtualFile`, `SourceMap` row says `types.ts`.
- `docs/architecture.md` "Block kinds" snippet (lines 30-45): core `BlockKind` with `tag`, `role`, `grammar`,
  `check`, `fillContext?`, `build?`, each half's registry (`packages/core/src/blocks/index.ts`,
  `packages/language-tools/src/blocks/index.ts`), the editor half as M2 names it (`EditorBlockKind` with `types?`,
  `editor?`), `VirtualFile.map: SourceMap | undefined`. Graphics unchanged: `grid.html` already says shared blocks
  fill `ctx` first.
- `docs/spec.md` 3.3: the class map module id `Card.ucf?ucf&type=style&index=0&module&lang.js`; 4.3 table: a
  "style class maps" row with that id, shared by React and Svelte.
- No `plan.md` or `publicdocs/` change (internal API, no user-facing behaviour yet).

## Fuzzing

None: the step names no fuzz test (orchestrator decision).

## Out of scope

- The exit test, `style-parity.spec.ts` (1.10).
- `build` for `react`, `vue`, `svelte`; `types` / `editor` halves; any Vite hook serving the style or class map modules.
- The `composes … from` crash in `compileStyles` (its own todo); `less` / `stylus` fixtures (risk 8).

## Found while building

- Review: `classMapId` was pinned on a made-up path, checked against itself per fixture; now pinned on `Card.ucf`'s
  real `ctx.modules.$style.id`. A registry shape test (which kinds have `fillContext` / `build`) was dropped: no real
  file, and `context.spec.ts` covers the style kind. The base test no longer claims to check `/` separators.
- Review, declined: dropping `filename`, `source`, `relativePath` or `StyleModule.name` from the context, and
  replacing the `fillContext` hook with a direct call. The step gives these exact shapes, and M3, M4 and M6 read them
  (`ctx.source`, `ctx.split`, the shared-kind loop of the registry design in `docs/architecture.md`).
- Review, declined: a Windows CI job to cover the `/` join. A new OS for the whole repo is outside this step.

## Decisions

- Shared types (`BuildContext`, `BuildContextOptions`, `StyleModule`, `VirtualFile`) in `types.ts`, not
  `context.ts` (orchestrator, AGENTS.md rule).
- A module block that does not compile keeps its `ctx.modules` entry with `classes: {}` (orchestrator).
- Duplicate module name: last block wins, as plugin-vue does (orchestrator).
- No fuzz test (orchestrator).

## Done when

- `createBuildContext()` gives every valid fixture its scope id, compiled styles with `styleId` ids, `hasScoped`,
  and a `StyleModule` per module name with `classMapId` ids; the style kind's `build` returns its CSS as `.css`.
- `BlockKind` has `fillContext?` and `build?`; `VirtualFile`, `BuildContext`, `BuildContextOptions`, `StyleModule`,
  `createBuildContext`, `classMapId` exported from core.
- `pnpm devx check` green; milestone doc, architecture snippet and spec 3.3 / 4.3 match what shipped; step 1.9 ends
  with `- Status: done`.
- Todo `git mv`'d into `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
