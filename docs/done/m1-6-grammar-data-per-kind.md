---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.6
---

# Milestone 1.6: grammar data per kind

## Problem

M2 builds the `.ucf` TextMate grammar and the `embeddedLanguages` of `packages/vscode` from the block registry. Each
kind must say which real grammar highlights its content, and for `<style>`, which one goes with each `lang`. Today
`BlockKind` (`packages/core/src/types.ts:32-36`) has only `tag`, `role` and `check`.

The milestone text said `vue` → `source.vue`. No real Vue grammar has that name now: the official Vue extension
(vuejs/language-tools `extensions/vscode/package.json`) and shiki 4.4.3 both name it `text.html.vue`. The 1.6 test is
built to catch exactly this, so the registry ships `text.html.vue`.

## Plan

1. **Types, `packages/core/src/types.ts`**, beside `BlockKind`:
   ```ts
   export interface GrammarScope {
     scopeName: string;  // TextMate root scope, e.g. 'source.tsx'
     languageId: string; // VS Code language id, e.g. 'typescriptreact'
   }
   export interface BlockGrammar extends GrammarScope {
     byLang?: Record<string, GrammarScope>; // picked by the block's lang attribute
   }
   ```
   `BlockKind` gets `grammar: BlockGrammar` (required, between `role` and `check`).
2. **Values, one per kind file:**
   - `blocks/style.ts`: `{scopeName: 'source.css', languageId: 'css', byLang: {scss: source.css.scss / scss,
     sass: source.sass / sass, less: source.css.less / less, styl: source.stylus / stylus,
     stylus: source.stylus / stylus, postcss: source.css.postcss / postcss}}`. `css` has no `byLang` entry: the
     default covers it.
   - `blocks/react.ts`: `source.tsx` / `typescriptreact`.
   - `blocks/vue.ts`: `text.html.vue` / `vue`.
   - `blocks/svelte.ts`: `source.svelte` / `svelte`.
3. **Exports, `packages/core/src/index.ts`**: the types `BlockGrammar` and `GrammarScope` (M2 names them; 1.9's export
   list already holds them).
4. **Root devDependency `shiki` 4.4.3**, exact pin, via `pnpm add -Dw shiki@4.4.3`: the newest version older than the
   30-day `minimumReleaseAge` (4.4.3 is from 2026-08-10; 4.5.0, 2026-10-01, is too young).
5. **Remove `packages/e2e/editor/.gitkeep`**: the folder now holds a spec.
6. **Docs**:
   - `docs/architecture.md:33`: the `BlockKind` snippet's `grammar` line becomes
     `grammar: {scopeName, languageId, byLang?}; // VS Code highlighting; byLang picked by <style lang>`.
   - Milestone 1: in 1.6 Values, `vue` → `text.html.vue` / `vue`; `shiki` pinned at 4.4.3 in 1.6 and in the
     "Root devDependencies" row of "Hands to later milestones"; `- Status: done` as the last line of 1.6.
   - `docs/milestones/m2-editor-basics.md:24` and `:63`, `docs/milestones/m4-vue-target.md:56` and `:107`:
     `source.vue` → `text.html.vue` (M2's renamed vendored copy `source.ucf.vue` stays).

## Tests

`packages/e2e/editor/grammar-scopes.spec.ts`, area **Editor**, `e2e` Vitest project. Runs in `pnpm devx test` on this
host and in CI's `Test` step. Needs only `shiki` (pure JS plus the oniguruma wasm it ships, no network, no browser):
no new CI piece. Uses the real `splitBlocks`, `BLOCK_KINDS`, `getBlockKind` from `@multifront/core` and
`listComponents()` / `readComponent()` from `fixtures/index.ts`.

- Setup (`beforeAll`): load every module of shiki's `bundledLanguages` (about 1,500 registrations, about 250 ms), map
  root `scopeName` → registration. One highlighter (`createHighlighter({themes: [], langs})`) with the languages owning
  the registry's scope names.
- `pickGrammar(block)`: `getBlockKind(block.type).grammar.byLang[lang]` when `lang` is a string key it owns
  (`Object.hasOwn`), else `grammar`.
- **Every registry scope is a real grammar**: every `scopeName` in `BLOCK_KINDS` and in each `byLang` is a key of the
  map; failure lists the missing names. A typo, or the old `source.vue`, fails here.
- **`it.each(listComponents())`, every block tokenizes with its grammar**: every block's `content`, line by line through
  `highlighter.getLanguage(name).tokenizeLine(line, ruleStack)` (state carried over). Every token's root scope is the
  picked `scopeName`, and no non-whitespace text is left at the root scope alone (no plain-text fallback).
- **Negative control (permanent)**: `Panel.ucf`'s `lang = scss` block through `source.css` instead of its pick leaves
  text at the root scope (`$`, `}`): the plain-text check catches a wrong pick.
- Checked while building: the old `source.vue` fails the first two tests, and a `byLang` key typo (`scsss`) fails the
  `Panel.ucf` case and the negative control.

## Fuzzing

None: static registry data. Tokenizing every real fixture block is the oracle; a fuzz run adds nothing.

## Out of scope

- Generating the `.ucf` grammar, `embeddedLanguages`, `packages/vscode`, `vscode-textmate` (M2).
- `less` / `stylus` / `sass` / `postcss` fixtures (milestone risk 8): their scope names are checked, no block of theirs
  is tokenized.
- A core helper that picks a block's grammar: the test picks inline, M2 picks by grammar lookahead.

## Decisions

- `vue` scope is `text.html.vue`, not `source.vue` (orchestrator: do what Vue does; the step's test catches the old name).
- The negative control stays as a permanent test (orchestrator: every step ends with a test that would fail without it).

## Done when

- `BlockKind.grammar` exists on all four kinds with the values above; `BlockGrammar`, `GrammarScope` exported from
  `@multifront/core`.
- `shiki` 4.4.3 is a root devDependency, exact-pinned, lockfile updated.
- `grammar-scopes.spec.ts` passes in `pnpm devx test`, and the CI log shows its tests ran.
- Milestone 1, 2 and 4 docs and `docs/architecture.md` match what shipped; 1.6 has `- Status: done`.
- `pnpm devx check` is green.
- The simplify-comments pass ran on every touched source file, committed on its own.
