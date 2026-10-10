---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.2
---

# Milestone 2.2: grammar from the registry

## Problem

M2 needs `.ucf` highlighting in every block, built from the block registry so a new row needs no grammar edit. Today
there is no `packages/vscode`; the registry (`packages/core/src/blocks/*.ts`) only holds each row's
`grammar: {scopeName, languageId, byLang?}`, and `packages/e2e/editor/grammar-scopes.spec.ts` (M1.6) only proves those
scope names are real.

Found while planning (an in-memory prototype with shiki's textmate fork passes on every valid fixture):

- **Injections only work at the document root.** vscode-textmate reads `injections`, and the grammars listed in
  `injectTo`, only for the document's root scope (`_collectInjections`). The Svelte grammar does all its script and
  style embedding in its own `injections` key, so a plain `include` of it leaves `<script lang="ts">` unhighlighted.
  Vue's three injection grammars target `text.html.vue`. So `generateGrammar` moves them up to `source.ucf` and limits
  each selector to its block.
- **Unscoped injections leak.** Vue's `vue.directives` is `L:meta.tag -meta.attribute …` and Svelte has
  `L:(source.ts, source.js, source.coffee)`: at the root of `source.ucf` they would fire in other blocks. Every lifted
  selector gets the block's scope in front (`L:meta.embedded.block.vue meta.tag …`).
- **Injection scope names clash too.** `vue.directives` and the other two collide with the official Vue extension just
  like `text.html.vue`, so they get renamed as well.
- **Splitter edges the milestone regex misses:** `</react >` (Hello.ucf), `<style scoped lang = scss>` (Panel.ucf),
  `module='classes'` (Button.ucf), `<!-- a <style> … -->` between blocks (TsxEdges.ucf), and `\b` letting `<react-x>`
  count as `<react>`.
- **Svelte upstream ships YAML only.** `svelte.tmLanguage.src.yaml` is turned into JSON at package time by js-yaml.
- **devx forces part of 2.3 into 2.2.** `checkTree()` in `scripts/devx.mjs` fails `pnpm devx typecheck` for any package
  missing from the root `vitest.config.ts`, and `tsc -p` runs on every package's `tsconfig.json`. So a new
  `packages/vscode` needs its `tsconfig.json`, its `vitest.config.ts` and the root project entry now.

## Plan

1. **Package `packages/vscode`** (`multifront-vscode`, `private: true`, `type: module`, version `0.0.0` like
   `packages/e2e`, license MIT, description line).
   - `exports: {"./grammar": {"source": "./src/grammar.ts"}}`. Dependencies: `@multifront/core: workspace:*`.
   - `tsconfig.json`: check only, extends `../../tsconfig.base.json` with `noEmit`, includes `src` and `*.config.ts`.
   - `vitest.config.ts`: project `vscode`, same shape as `packages/core/vitest.config.ts`, include
     `test/**/*.spec.ts`. If vitest refuses a project with no files, `passWithNoTests` on that project only.
   - Root `vitest.config.ts` gets `'packages/vscode/vitest.config.ts'`. No root `tsconfig.json` reference (private).
2. **Vendored grammars**, `packages/vscode/syntaxes/vendor/`:
   - `vue/`: `vue.tmLanguage.json`, `vue-directives.json`, `vue-interpolations.json`,
     `vue-sfc-style-variable-injection.json`, byte-for-byte from vuejs/language-tools
     `85f665e9397b028c48d3ddd6ecd9a46e3fadeb94`, `extensions/vscode/syntaxes/`, plus its root `LICENSE` (MIT).
   - `svelte/`: `svelte.tmLanguage.json`, converted from sveltejs/language-tools
     `af7c6a505a8aa631f5ca7794f41163e46cb0bc33` `packages/svelte-vscode/syntaxes/svelte.tmLanguage.src.yaml` with the
     js-yaml CLI, as upstream's `build:grammar` script does. Plus its root `LICENSE` (MIT).
   - `sources.json`: per grammar the repo, commit, license, upstream path of each file, and for Svelte the exact
     conversion command.
   - Upstream's pug and markdown injections are left out (no pug or markdown inside a `.ucf` block).
3. **Types**, `packages/vscode/src/types.ts`: `TmRule`, `TmGrammar`
   (`scopeName`, `patterns`, `repository?`, `injections?`, `injectionSelector?`), and
   `GrammarFile {scopeName; path; grammar; injectTo?}`, where `path` is the file name 2.3 writes under
   `dist/syntaxes/` (`<scopeName>.tmLanguage.json`) and `injectTo` is `['source.ucf']` for an injection grammar.
4. **`packages/vscode/src/grammar.ts`**:
   `generateGrammar(kinds: readonly BlockKind[] = BLOCK_KINDS): GrammarFile[]` and `ROOT_SCOPE`, plus a type re-export of `GrammarFile`
   and `TmGrammar`. It reads the vendored JSON with `readFileSync(new URL('../syntaxes/vendor/…', import.meta.url))`,
   not JSON imports, so no tsconfig changes in e2e. A table maps registry scopes to copies: `'text.html.vue'` → vue
   main + 3 injections, `'source.svelte'` → svelte main.
   - Root `source.ucf` (first item):
     - First pattern: `<!--` … `-->` as `comment.block.ucf`, so a tag in a comment opens nothing.
     - Then for each row, one rule per `byLang` entry, then the default. Each is a two-phase begin/end, so attributes
       may span lines: begin `(<)(tag)(?![^\s/>])`, end `(</)(tag)(?=[\s>])[^>]*(>)?`, attribute patterns, tag
       punctuation and name (`entity.name.tag.ucf`), then an inner rule begin `(>)`, end `(?=</tag(?:[\s>]|$))`, with
       the content name and `include: <scope>`.
     - `contentName` is `meta.embedded.block.<tag>`; a `byLang` rule uses `meta.embedded.block.<tag>.<languageId>`
       (e.g. `meta.embedded.block.style.scss`), so 2.3 can map each one to its language.
     - The `byLang` lookahead is `(?=[^>]*[\s/]lang\s*=\s*(?:"x"|'x'|x(?![^\s>])))` on the escaped key.
   - Each vendored main copy is served as `source.ucf.<tag>`. Every `include` of the old scope (or `old#x`) is
     rewritten to the new one. Its own `injections` move into the root's: `#x` and `$self` become
     `source.ucf.<tag>#x`, and each comma alternative of the selector becomes
     `<L:|R:>meta.embedded.block.<tag> <rest>`.
   - Each injection grammar is served as `ucf.<old scope>` (`ucf.vue.directives`, …), with includes rewritten, its
     selector limited the same way, and `injectTo: ['source.ucf']`.
   - Token scopes inside every copy stay as upstream.
5. **Root devDependencies**, exact: `vscode-textmate@9.3.2`, `vscode-oniguruma@2.0.1` (both older than the 30-day
   `minimumReleaseAge`). `@multifront/e2e` gets `"multifront-vscode": "workspace:*"`.
6. **Docs.**
   - `docs/architecture.md`, Highlighting bullet: one sentence saying the copies are served under our own scopes and
     their injections are limited to their block.
   - Milestone 2: 2.2 Build text matches what shipped; 2.3 drops "gets tsconfig.json and joins the root
     vitest.config.ts"; "Hands to later milestones" names `GrammarFile[]` and the scope names; `- Status: done` last
     in 2.2. Every later milestone doc naming `generateGrammar` gets the `GrammarFile[]` shape.

## Tests

All run on this host and in CI's existing `Test` step (`pnpm devx test`, `e2e` project). Needs only pure JS and WASM:
vscode-textmate, vscode-oniguruma's `onig.wasm`, shiki. No network, no new infra.

- **Helper** `packages/e2e/editor/lib/tokenize.ts`: `tokenizeUcf(path, grammars: GrammarFile[])` returns
  `ScopedToken[]` (`{start, end, text, scopes}`, file offsets). It loads `onig.wasm` once into a real `vscode-textmate`
  `Registry`. Our grammars go through `parseRawGrammar(JSON.stringify(grammar), path)`, as VS Code reads the files.
  Every other scope (VS Code's built-ins) comes from shiki's `bundledLanguages`, mapped by `scopeName` and cached.
  `getInjections` comes from `injectTo`. Also exports `hasScope(token, scope)` (the TextMate prefix rule).
- **`packages/e2e/editor/grammar.spec.ts`:**
  - **Own scopes.** `generateGrammar()[0]` is `source.ucf`; every scope name starts with `source.ucf` or `ucf.`.
  - **Exact cover.** For every name in `listComponents()` and `listComponents('langs')`, every non-newline character
    in `[contentStart, contentEnd)` of a real `splitBlocks` block carries `meta.embedded.block.<tag>`, and no character
    outside carries any `meta.embedded.block.<registry tag>`. Mismatches listed with line and column.
  - **Spot checks**, Card.ucf: `export` in `<react>` is `keyword.control.export.tsx`; in `<vue>`, `:` is
    `punctuation.attribute-shorthand.bind.html.vue`, `class` is `entity.other.attribute-name.html.vue`, `{{` is
    `punctuation.definition.interpolation.begin.html.vue`; in `<svelte>`, `{` of `{title}` is
    `punctuation.section.embedded.begin.svelte`, `title` is `meta.embedded.expression.svelte`, `let` in
    `<script lang="ts">` carries `source.ts`; the `react` of `<react>` is `entity.name.tag.ucf`. Panel.ucf: `$pad` is
    `variable.scss`.
  - **TsxEdges.ucf**: the `</` token at `contentEnd` has no `meta.embedded` scope, and the `}` before it still has
    `meta.embedded.block.react`.
  - **Negative control**, `invalid/ReactCloseInString.ucf`: the react scope runs past the splitter's `contentEnd`, the
    documented limit; proves the exact-cover check can fail.

## Docs

`docs/architecture.md` "Editor and types", Highlighting bullet, and the milestone doc edits in Plan 6. `docs/plan.md`
and `docs/spec.md` unchanged; no `publicdocs/` page describes highlighting yet.

## Decisions

- No fuzz test in 2.2: the milestone puts none in this step (orchestrator).
- The `packages/vscode` tsconfig, vitest project and root `vitest.config.ts` entry move from 2.3 into 2.2; 2.3's text
  is edited to match (orchestrator).
- `generateGrammar` returns `GrammarFile[]`: every milestone doc naming it gets that shape (orchestrator).

## Out of scope

- `contributes` (language, grammar, `embeddedLanguages`), `language-configuration.json`, the icon, `pnpm devx vsix`,
  writing `dist/syntaxes/`: all 2.3.
- Upstream pug and markdown injections.
- A closing tag split across lines, and a `lang` attribute on a later line than `<style`: that block falls back to the
  default style grammar.

## Done when

- `generateGrammar()` returns the root grammar and the renamed vendored set.
- `grammar.spec.ts` green in `pnpm devx test` and in CI; `pnpm devx check` passes.
- Milestone doc and architecture.md updated; `- Status: done` on 2.2; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
