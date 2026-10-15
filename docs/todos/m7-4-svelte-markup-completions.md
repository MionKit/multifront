---
type: feature
spec: full-plan
status: ready
created: 2026-10-15
milestone: 7
step: 7.4
---

# Svelte markup completions: tags, Svelte elements, directives, blocks

## Problem

The `<svelte>` block gets TypeScript from tsserver (M5: svelte2tsx inside `{…}` and the script), and nothing else in
its markup: `<sv` lists no tags, `<input bi` no attributes, `{#` no blocks. Our language server builds no `<svelte>`
code at all: it never loads a Svelte compiler (`server.ts:141`, `createUcfLanguagePlugin({ts})`), so
`svelteEditorKind.editor()` (`blocks/svelte.ts:97`) returns `[]` there.

Checked before planning:

- vscode-html-languageservice 5.6.2 (what `volar-service-html` 0.0.71 resolves, already in the lockfile through
  `@vue/language-service`): `<sv` gives tag items whose newText is the bare name; `<input bi` gives `name="$1"`
  snippets, custom data included; an attribute already in the tag is left out.
- The real `svelte/compiler` `parse` (modern) throws on `<svelte:element />` with no `this`; on
  `<svelte:window|document|body|head|options>` inside an element or a block; on a self-closing top-level `<script />`
  or `<style />`; on `bind:value=""`, `bind:value={}`, a bare `bind:` / `class:`; on `{:else}` outside `{#if}` /
  `{#each}`, `{:then}` inside `{#if}`; on `{@render x}` with no call. Plain HTML data would suggest invalid Svelte, so
  those items are rewritten or dropped.
- Volar's completion runs the embedded codes first and the root code last; a non-additional plugin on the root still
  answers when no embedded code gave items there.
- `{ti` with no `}` gives no svelte2tsx script (the loose parse fails); `{ti}` does. VS Code auto-closes `{` in `.ucf`
  (`packages/vscode/language-configuration.json`), so typing `{ti` holds `{ti}`. The tests type what VS Code holds.

## Decisions

Answers from the run-milestone orchestrator:

1. `vscode-html-languageservice` 5.6.2 is pinned as a dependency of `@multifront/language-tools`, for
   `newHTMLDataProvider` and its data types; the milestone's "Outside the milestones" list names it.
2. No fuzz test in this step: 7.4's test asks for the parse-every-suggestion check, not a fuzz test.
3. The code's language id is `svelte-markup`, `name={…}` is blanked to `"…"`, and the tests type `{ti}` / `{#}` as
   VS Code's auto-close leaves them: each stated in 7.4's Build and Test lines with its reason.

## Plan

1. `packages/language-tools/src/blocks/svelteMarkup.ts` (new): one lexical pass over the block content, no compiler
   (so the server can run it):
   - `scanMarkup(content)` returns `code` (same length: `<script>` contents and every `{…}` become spaces; an attribute
     value `name={…}` becomes `"…"` with spaces inside, so the HTML scanner reads one quoted value; with plain spaces
     the next attribute would be read as its value), `pieces` (the spans kept), `events` (element open / close, block
     `{#name` / `{:name` / `{/name`, each at its end offset) and the `ranges` a completion cannot start in (tags,
     comments, raw text, expressions). Braces skip quotes and template literals inside an expression, escapes
     included. An unclosed `{` is blanked up to the next `<`.
   - `openAt(scan, offset)`: the stack of open elements and blocks before `offset`, each block with its current
     branch (`{#await p then v}` starts in `then`).
2. `blocks/svelte.ts` `editor()` always adds the code `{id: 'svelte_markup', languageId: 'svelte-markup'}`, its
   `pieces` mapped 1:1 with `{completion: true}` only (no HTML diagnostics, formatting, hover or links), beside the
   svelte2tsx code when a compiler is there, alone otherwise. `{…}` is unmapped: expressions get only TypeScript's
   completions. The language id is not `html`, so Vue's template plugins and our HTML service never serve each
   other's codes.
3. `languagePlugin.ts:47` keeps the id of a `VirtualCode` an `editor()` built; `blocks/vue.ts` `editor()` names its
   code `vue` itself. Otherwise both `<svelte>` codes would get the id `svelte`.
4. `packages/language-tools/src/blocks/svelteHtmlData.ts` (new): `SVELTE_HTML_DATA`, HTML custom data: the tags
   `svelte:window`, `svelte:document`, `svelte:body`, `svelte:head`, `svelte:element` (attribute `this`),
   `svelte:boundary`, `svelte:options` with one-line descriptions; global attributes: the prefixes `bind:`, `class:`,
   `style:`, `use:`, `transition:`, `in:`, `out:`, `animate:`, plus `bind:this`, the size binds and
   `bind:innerHTML` / `bind:innerText` / `bind:textContent`; per tag: `input` (`bind:value`, `bind:checked`,
   `bind:group`, `bind:files`, `bind:indeterminate`), `textarea` and `select` (`bind:value`), `details`
   (`bind:open`), `audio` / `video` (media binds), `img` (`bind:naturalWidth`, `bind:naturalHeight`).
5. `packages/language-tools/src/svelteMarkupService.ts` (new): `svelteMarkupServices()`, two Volar service plugins:
   - The HTML service: `volar-service-html` `create({documentSelector: ['svelte-markup'], getCustomData: () =>
     [newHTMLDataProvider('svelte', SVELTE_HTML_DATA)]})`, its `provideCompletionItems` wrapped so each item is valid
     Svelte where it lands, from `openAt` on the real block text (the root, decoded from the embedded URI): the meta
     tags only at the top level; `style` dropped at the top level (styles are root blocks); `script` dropped at the
     top level once the block has one; `svelte:element` inserts `svelte:element this={$1}`; a directive (name with
     `:`) or an `on*` event attribute inserts `={$1}`, not `="$1"`; a prefix inserts `bind:${1:name}`.
   - `multifront-svelte-markup` (trigger characters `#`, `@`, `:`): on the root `.ucf` document, when the text before
     the cursor in the `<svelte>` markup is `{#`, `{@` or `{:` plus a word, at a text position. Snippet items, the edit
     also taking a `}` the editor auto-closed: `{#` `if`, `each`, `await`, `key`, `snippet`; `{@` `render`
     (`render ${1:children}()`), `html`, `debug`, and `const` only as the direct child of `{#if}` / `{:else}` /
     `{#each}` / `{#snippet}` / `{:then}` / `{:catch}`, a component or `<svelte:boundary>`; `{:` `else` in an `{#if}`
     or `{#each}` not yet in `{:else}`, `then` in a pending `{#await}`, `catch` in an `{#await}` not yet in
     `{:catch}`.
6. `server.ts:142` adds `...svelteMarkupServices()` to the services.
7. Dependencies of `@multifront/language-tools`, exact: `volar-service-html` `0.0.71` and `vscode-html-languageservice`
   `5.6.2`, both already in the lockfile, past the 30-day age. The VS Code bundle takes them in with the server.

## Tests

All on this host and in CI's `check` job (`pnpm devx test`), area Editor, real child processes only.

- New fixture `packages/e2e/fixtures/apps/svelte-markup/Toolbar.ucf`: a `<svelte>` block (a TS script with
  `title`, `items` and `load` props and a `query` `$state`; markup with `class={$style.toolbar}`, `<h2>{title}</h2>`,
  `<input bind:value={query} />`, `{#if}`, `{#each}`, `{#await load}…{:then text}…{/await}`) and a `<style module>`.
  No tsconfig: tsserver gets inferred-project options, as `svelte-block.spec.ts` does.
- `packages/e2e/editor/server/svelte-markup.spec.ts`, the real server over LSP and the real tsserver with our plugin
  on the fixture folder. Each case types a real unsaved edit and reverts it:
  1. `<sv` at the top level lists `svelte:window`, the other six `svelte:*` elements and `div`.
  2. `<sv` inside `<div>` lists `svelte:boundary` and `svelte:element`, not `svelte:window`, `svelte:head` or
     `svelte:options`.
  3. `<input bi />` lists `bind:value`, `bind:this` and `bind:`.
  4. `{#` and `{#}` (VS Code's auto-close) list `if`, `each`, `await`, `key`, `snippet`.
  5. `{@` at the top level lists `render`, `html`, `debug`, not `const`; inside `{#each}` it lists `const`.
  6. `{:` inside `{#if}` lists `else` only; inside the pending `{#await}` `then` and `catch`; at the top level nothing.
  7. `{ti}`: tsserver's `completionInfo` lists the `title` prop; the server lists no HTML tag there.
  8. Every item of cases 1 to 6, applied to a copy (its text edit; a tab stop filled with its placeholder or `x`, `$0`
     empty; ` />` after a tag name, as the user finishes the tag), leaves a `<svelte>` block the real
     `svelte/compiler` `parse` (modern, not loose) accepts.
  9. The server logged no warning or error.

  Helpers `applyCompletion()` and `fillSnippet()` in `editor/lib/svelte.ts`, for 7.5 too.
- `packages/e2e/editor/virtualCode.spec.ts`: every fixture with a `<svelte>` block now has the `svelte_markup` code
  after its react code; a new case checks it (same length as the block, pieces in order, `{completion: true}` only);
  file snapshots `<name>.svelte_markup.html` pin the blanked text (`EXTS` gains `'svelte-markup': '.html'`).
- The other editor specs stay green: `vue-block*` (Vue codes keep the id `vue`), `svelte-*`, `bundle`, `vsix`.

## Docs

- `docs/spec.md` section 6, "Order" item 5: markup completions through the language server's HTML service and block
  completions.
- `docs/architecture.md`: the "Inside a `.ucf` file" paragraph gets the `svelte_markup` code; the host table's
  language server row reads "template and Svelte markup HTML". The language graphic already shows "ts code + html"
  for `<svelte>`: no image change.
- `publicdocs/05-editor-setup.md`: the `<svelte>` row gains markup completions.
- Milestone doc step 7.4: text matches what shipped (language id, `"…"` values, item rules, `{ti}` / `{#}`), the second
  dependency under "Outside the milestones", `- Status: done`.

## Out of scope

- Component props after `<Icon ` (7.5). Hover, diagnostics or formatting of the markup. `svelte:options` /
  `svelte:window` attribute data. `{/if}` closing-block items. Emmet.

## Done when

- `pnpm devx check` green with the new spec and the updated `virtualCode.spec.ts` running.
- The docs above updated, the milestone step `- Status: done`, this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
