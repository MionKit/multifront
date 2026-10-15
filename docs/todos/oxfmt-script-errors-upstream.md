---
type: chore
spec: guidelines
status: blocked
created: 2026-10-15
---

# Report oxfmt's silent `<script>` parse errors upstream, then drop `mf-fmt`'s own check

## Intent

oxfmt 0.67.0's `format()` (and its CLI) returns no error for a `<script>` that does not parse inside a `.vue` or
`.svelte` file: it keeps that script as written, formats the rest, and for `.svelte` prints a
`oxfmt::textToDoc() failed` stack on stderr. `formatUcf` in `packages/language-tools/src/format/index.ts` works around
it: `scriptError` sends each root `<script>` (from core's `blockScripts`) to `format()` on its own first. That is
extra code and one extra `format()` call per script, kept only because oxfmt is silent. Nobody has reported it upstream
yet: the session that added the check had no access to `oxc-project/oxc`.

Reproduce (repo root):

```js
import {format} from 'oxfmt';
await format('X.vue', '<script setup lang="ts">let a = ;</script>\n<template><p/></template>', {}); // errors: []
await format('X.svelte', '<script lang="ts">let a = ;</script><p/>', {svelte: true}); // errors: [], stack on stderr
```

## Direction

- A human files the issue on `oxc-project/oxc` with the two snippets above (blocked until then).
- Once a released oxfmt returns those errors itself: bump the pin, delete `scriptError` and `SCRIPT_ENDINGS`, and drop
  `blockScripts` from core if nothing else uses it. The `<vue>` / `<svelte>` broken-script tests in
  `packages/e2e/editor/format/` stay as the pin; adjust only their expected span or message if oxfmt's differ.

## Done when

- The upstream issue is filed, and either fixed in the pinned oxfmt with the workaround removed and the tests green,
  or still open with its link recorded here.
