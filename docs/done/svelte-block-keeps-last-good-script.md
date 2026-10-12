---
type: feature
spec: guidelines
status: done
created: 2026-10-12
---

# Editor: keep a `<svelte>` block's last good script while its markup does not parse

## Intent

While a `<svelte>` block's markup does not parse even with Svelte's loose parser (an unclosed `{`, as in `fixtures/components/svelte/errors/UnclosedBrace.ucf`), svelte2tsx throws and `svelteTypes` in `packages/language-tools/src/blocks/svelte.ts` returns no script. Then tsserver serves no `Card.ucf.svelte.ts`: every `.ts` importer of a svelte pick gets TypeScript's `TS2307` and every feature inside the block stops, until the markup parses again. One keystroke mid-edit turns the whole project red. Vue's language tools keep serving the last good code in that state; ours should too.

## Direction

- Per `.ucf` file, remember the last `<svelte>` script that built. When svelte2tsx throws a Svelte `CompileError`, serve that one. Its mappings point into the old text, so map nothing inside the block, or only what still lines up, rather than report wrong positions.
- Where to keep it: the editor half has no state today. The language plugin's root code per file (`createRootCode` in `src/languagePlugin.ts`) or a `WeakMap` keyed by file name are candidates. The implementer picks one and plans the details, including disposal (`disposeVirtualCode`).
- The `<vue>` block may have the same gap: check what `@vue/language-core` does on an SFC error before designing.
- Showing Svelte's own parse error in the editor (`svelte-parse-error`) is a separate job, which milestone 7 owns.

## Docs

`docs/architecture.md` "Inside a `.ucf` file" gets one line if the plugin gains per-file state. No publicdocs page describes this.

## Done when

- With `Panel.ucf`'s `{@render children?.()}` left unclosed in an unsaved edit, a `.ts` importer of its svelte pick keeps its types (no `TS2307`), in the real tsserver with our plugin.
- The block serves no wrong positions while the old script is in use.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Plan: keep the last script in the language plugin (approved 2026-10-12, automatic mode)

- `<vue>` has no gap: `@vue/language-core` keeps `script_ts` through a broken template, script or tag.
- `createUcfLanguagePlugin` gains `updateVirtualCode`: Volar hands it the file's last root on every edit, and
  forgets it when the script is deleted. The language server's URI wrapper forwards it too.
- `createEditorContext` takes that root as `ctx.previous`. Svelte's `editor()`, when svelte2tsx throws a
  `CompileError`, serves the previous root's `svelte` code with no mappings. Its snapshot can stay: the tsserver
  target language rebuilds its code (and mappings) whenever the `.ucf` file it is associated with changes.
- `getTypesScript` stays stateless: a file that never built still gets no script.
- Tests (`packages/e2e/editor/svelte-types.spec.ts`): in the real tsserver with our plugin, `Panel.ucf` edited to an
  unclosed `{@render …` keeps `main.ts`'s `ComponentProps<typeof Panel>['heading']` a `string`, no diagnostics, and a
  hover inside the block gets nothing. Through the language plugin: the kept code has the last text and no mappings
  across two broken edits, and none once the script is deleted (the file leaves the project).
- Docs: one line in `docs/architecture.md` "Inside a `.ucf` file".
