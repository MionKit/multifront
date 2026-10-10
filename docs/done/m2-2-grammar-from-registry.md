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
  Vue's four injection grammars target `text.html.vue`. So `generateGrammar` moves them up to `source.ucf` and limits
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
   - `vue/`: `vue.tmLanguage.json` and the four injection grammars upstream contributes to it
     (`vue-directives.json`, `vue-interpolations.json`, `vue-sfc-script-leading-operator-fix.json`,
     `vue-sfc-style-variable-injection.json`), byte-for-byte from vuejs/language-tools
     `85f665e9397b028c48d3ddd6ecd9a46e3fadeb94`, `extensions/vscode/syntaxes/`, plus its root `LICENSE` (MIT).
   - `svelte/`: `svelte.tmLanguage.json`, converted from sveltejs/language-tools
     `af7c6a505a8aa631f5ca7794f41163e46cb0bc33` `packages/svelte-vscode/syntaxes/svelte.tmLanguage.src.yaml` with
     `npx js-yaml@3.14.1`, as upstream's `build:grammar` script does. Plus its root `LICENSE` (MIT).
   - `sources.json`: per grammar the repo, commit, license, upstream path of each file, and for Svelte the exact
     conversion command.
   - Upstream's pug and markdown injections are left out (no pug or markdown inside a `.ucf` block).
3. **Types**, `packages/vscode/src/types.ts`: `TmRule` (`IRawGrammar['patterns'][number]` of vscode-textmate),
   `TmGrammar` (`IRawGrammar` with an optional `repository`), and `GrammarFile {scopeName; path; grammar; injectTo?}`,
   where `path` is the file name 2.3 writes under `dist/syntaxes/` (`<scopeName>.tmLanguage.json`) and `injectTo` is
   `['source.ucf']` for an injection grammar.
4. **`packages/vscode/src/grammar.ts`**: `generateGrammar(kinds: readonly BlockKind[] = BLOCK_KINDS): GrammarFile[]`,
   plus a type re-export of `GrammarFile`. It reads the vendored JSON with
   `readFileSync(new URL('../syntaxes/vendor/…', import.meta.url))`, not JSON imports, so no tsconfig changes in e2e.
   A table maps registry scopes to copies: `'text.html.vue'` → vue main + 4 injections, `'source.svelte'` → svelte
   main.
   - Root `source.ucf` (first item):
     - First pattern: `<!--` … `-->` as `comment.block.ucf`, so a tag in a comment opens nothing.
     - Then one rule per row, mirroring the splitter's tag rules. Begin `(<)(tag)(?![^\s/>])(?![^>]*/>)`: a name ends
       at a space, `/` or `>`, and a self-closing tag opens nothing. End `(</)(tag)(?=[\s>])[^>]*(>)?`, or a quote
       that holds a `>` or runs past the line (the splitter drops that opening tag). Patterns: one `lang` rule per
       `byLang` entry, the attribute rule, then the content rule (begin `(>)`, end `(?=</tag(?:[\s>]|$))`,
       `contentName: meta.embedded.block.<tag>`, `include: <scope>`). Attributes may span lines.
     - A `lang` rule begins at the attribute itself, `(?<![^\s/])(lang)\s*(=)\s*(?:("x")|('x')|(x)(?![^\s>]))`, on
       any line of the tag, and holds the attribute rule plus a content rule named
       `meta.embedded.block.<tag>.<languageId>` (e.g. `meta.embedded.block.style.scss`), so 2.3 can map each one to its
       language. It is listed before the attribute rule, so it wins at `lang`; the attribute rule swallows a quoted
       value, so `title="a lang=scss b"` picks nothing, as in the splitter.
   - Each vendored main copy is served as `source.ucf.<tag>`. Every `include` of the old scope (or `old#x`) is
     rewritten to the new one. Its own `injections` move into the root's, with `#x` anchored to `source.ucf.<tag>#x`.
   - Each injection grammar is served as `<copy scope>.<old scope>` (`source.ucf.vue.vue.directives`, …), with
     includes rewritten and `injectTo: ['source.ucf']`.
   - Every moved or injected selector is limited to its block: each comma alternative gets
     `meta.embedded.block.<tag>` in front, or, when it names the upstream root scope (`L:text.html.vue source.js`), the
     block scope takes that scope's place.
   - Token scopes inside every copy stay as upstream.
5. **Root devDependencies**, exact: `vscode-textmate@9.3.2`, `vscode-oniguruma@2.0.1` (both older than the 30-day
   `minimumReleaseAge`). `@multifront/e2e` gets `"multifront-vscode": "workspace:*"`.
6. **Docs.**
   - `docs/architecture.md`, Highlighting bullet: one sentence saying the copies are served under our own scopes and
     their injections are limited to their block.
   - Milestone 2: 2.2 Build text matches what shipped; 2.3 drops "gets tsconfig.json and joins the root
     vitest.config.ts"; "Hands to later milestones" names `GrammarFile[]`, the scope names and the new fixture;
     `- Status: done` last in 2.2. No later milestone doc names `generateGrammar`.
   - `packages/AGENTS.md`: `vscode` is private with no build half, and named `multifront-vscode` outside
     `@multifront/*` because vsce refuses a scoped extension name.

## Tests

All run on this host and in CI's existing `Test` step (`pnpm devx test`, `e2e` project). Needs only pure JS and WASM:
vscode-textmate, vscode-oniguruma's `onig.wasm`, shiki. No network, no new infra.

- **Helper** `packages/e2e/editor/lib/tokenize.ts`: `tokenizeUcf(path, grammars: GrammarFile[])` returns
  `ScopedToken[]` (`{start, end, scopes}`, file offsets). It loads `onig.wasm` once into a real `vscode-textmate`
  `Registry`. Our grammars go through `parseRawGrammar(JSON.stringify(grammar), path)`, as VS Code reads the files.
  Every other scope (VS Code's built-ins) comes from shiki's `bundledLanguages`, mapped by `scopeName` and cached.
  `getInjections` comes from `injectTo`. Also exports `hasScope(token, scope)` (the TextMate prefix rule).
- **New fixture** `packages/e2e/fixtures/components/editor/GrammarEdges.ucf` (valid; the `editor/` folder stays out
  of M1's loops): a `<style>` tag over several lines with `lang="scss"` on a later line and `>` alone, `lang='less'`,
  `title="a lang=scss b"`, a Vue `<script setup>` line starting with `< limit`, a Svelte `<template>`.
- **`packages/e2e/editor/grammar.spec.ts`:**
  - **Own scopes.** `generateGrammar()[0]` is `source.ucf`; every scope name starts with `source.ucf`; no `include`
    names `text.html.vue`, `source.svelte` or `vue.*` (shiki holds those too, so a missed rename would still
    highlight).
  - **Exact cover and no leaks.** For every name in `listComponents()`, `listComponents('langs')`,
    `listComponents('editor')`, `invalid/BrokenOpeningTags.ucf` (self-closing tag, open quote) and
    `invalid/UnknownRootTag.ucf` (`<react_old>`): every character in `[contentStart, contentEnd)` of a real
    `splitBlocks` block carries exactly its content scope (`.<languageId>` when `lang` picks a `byLang` grammar), no
    character outside carries one, and no `.vue` or `.svelte` scope shows outside its own block. Mismatches listed with
    line and column.
  - **Spot checks**, Card.ucf: `export` in `<react>` is `keyword.control.export.tsx`; in `<vue>`, `:` is
    `punctuation.attribute-shorthand.bind.html.vue`, `class` is `entity.other.attribute-name.html.vue`, `{{` is
    `punctuation.definition.interpolation.begin.html.vue`; in `<svelte>`, `{` of `{title}` is
    `punctuation.section.embedded.begin.svelte`, `title` is `meta.embedded.expression.svelte`, `let` in
    `<script lang="ts">` carries `source.ts`; the `react` of `<react>` is `entity.name.tag.ucf`. Panel.ucf: `$pad` is
    `variable.scss`. GrammarEdges.ucf: the leading `<` is `keyword.operator.relational.js` (the leading-operator fix,
    whose selector names `text.html.vue`); `{` in the Svelte `<template>` is
    `punctuation.section.embedded.begin.svelte` (reached through the anchored `#scope`); `$gap` is `variable.scss`.
  - **TsxEdges.ucf**: the `</` token at `contentEnd` has no `meta.embedded` scope, and the `}` before it still has
    `meta.embedded.block.react`.
  - **Negative control**, `invalid/ReactCloseInString.ucf`: the react scope runs past the splitter's `contentEnd`, the
    documented limit; proves the exact-cover check can fail.
  - Each new piece was broken once on purpose (no narrowing, no `#x` anchor, no leading-operator fix, no include
    rename, no self-closing guard, no broken-quote end) and a test above failed every time.

## Docs

`docs/architecture.md` "Editor and types", Highlighting bullet, and the milestone doc edits in Plan 6. `docs/plan.md`
and `docs/spec.md` unchanged; no `publicdocs/` page describes highlighting yet.

## Decisions

- No fuzz test in 2.2: the milestone puts none in this step (orchestrator).
- The `packages/vscode` tsconfig, vitest project and root `vitest.config.ts` entry move from 2.3 into 2.2; 2.3's text
  is edited to match (orchestrator).
- `generateGrammar` returns `GrammarFile[]`: every milestone doc naming it gets that shape (orchestrator).
- Review fixes: `lang` on any line of the tag, the fourth Vue injection grammar, injection scope names under the copy's
  scope, self-closing and broken-quote tags open nothing, raw grammar types from vscode-textmate, and the tests above.

## Out of scope

- `contributes` (language, grammar, `embeddedLanguages`), `language-configuration.json`, the icon, `pnpm devx vsix`,
  writing `dist/syntaxes/`: all 2.3.
- Upstream pug and markdown injections.
- A closing tag split across lines.

## Done when

- `generateGrammar()` returns the root grammar and the renamed vendored set.
- `grammar.spec.ts` green in `pnpm devx test` and in CI; `pnpm devx check` passes.
- Milestone doc and architecture.md updated; `- Status: done` on 2.2; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
