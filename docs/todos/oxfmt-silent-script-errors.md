---
type: fix
spec: guidelines
status: ready
created: 2026-10-15
---

# mf-fmt passes a `<script>` that does not parse inside `<vue>` and `<svelte>` blocks

## Intent

A `<script>` syntax error inside a `<vue>` or `<svelte>` block (`let a = ;`) gives no `format-error`. oxfmt 0.67.0's
`format()` returns no error for it: it leaves that script as written, formats the rest of the block, and for a
`.svelte` file prints a `oxfmt::textToDoc() failed` stack on stderr. So `mf-fmt` exits 0, counts the file as formatted,
and its own stderr carries a stack trace no command rule allows (spec 8.1: stderr only on exit 2). The oxfmt CLI does
the same, so this is upstream behaviour, but a coding agent reading `mf-fmt` is told a broken file is fine.

Reproduce (repo root):

```js
import {format} from 'oxfmt';
await format('X.vue', '<script setup lang="ts">let a = ;</script>\n<template><p/></template>', {}); // errors: []
await format('X.svelte', '<script lang="ts">let a = ;</script><p/>', {svelte: true}); // errors: [], stack on stderr
```

## Direction

- First report it upstream on `oxc-project/oxc` (embedded script parse errors swallowed by `format()` and the CLI),
  with the two snippets above.
- Meanwhile, decide whether `formatUcf` should catch it itself. One cheap way: oxfmt's `format()` on the script's own
  text as `.ts` / `.tsx` gives a labelled error; mapping it back to the `.ucf` file reuses `errorSpan`. Keep the stderr
  stack out of `mf-fmt`'s output either way.
- The implementer investigates and plans the details.

## Docs

`docs/architecture.md` `mf-fmt` bullet if `formatUcf` gains the check; spec 6.1 otherwise unchanged.

## Done when

- A `<script>` that does not parse in a `<vue>` or `<svelte>` block gives a `format-error` at its `.ucf` position and
  leaves the file as written, or the upstream fix is in the pinned oxfmt and a test pins it.
- `mf-fmt` prints nothing on stderr for it.
- The simplify-comments pass ran on every touched source file, committed on its own.
