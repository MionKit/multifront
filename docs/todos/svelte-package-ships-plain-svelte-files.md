---
type: feature
spec: guidelines
status: ready
created: 2026-10-13
---

# The Svelte package ships plain `.svelte` files of `src` as source

## Intent

A Svelte library often mixes `.ucf` components with plain `.svelte` components or `.svelte.ts` runes modules. Today
`buildLibrary()` fails on them ("a library package ships svelte code from .ucf <svelte> blocks only"): compiled by
plugin-svelte they would ship pinned to the library's Svelte internals, while the shipped `.svelte` sources still import
`./Child.svelte`. svelte-package ships them as source: `.svelte` copied (preprocessed), `.svelte.ts` stripped of types
to `.svelte.js`. Library authors should be able to do the same.

## Direction

- The check sits in `librarySource()`'s `generateBundle` (`packages/vite/src/library/source.ts`, `PLAIN_SVELTE`).
  Instead of failing, drop those compiled chunks too and emit the source, the way components are emitted.
- A plain `.svelte` file may import `.ucf` files: its `.ucf` specifiers need the same rewrite core's library mode does
  (`shipUcfImports` in `packages/core/src/svelte/library.ts`), which offsets by a `.ucf` block's `contentStart`; a whole
  file needs it without that offset.
- A `.svelte.ts` module ships as `.svelte.js` with its types stripped (not compiled); importers already name
  `./x.svelte.js`.
- The types stage (`emitSvelteTypes` in `packages/vite/src/library/dts.ts`) copies plain files, but its
  `tsc --listFilesOnly` run reads only the `.ucf` components through svelte2tsx copies: a plain `.svelte` root needs
  the same copy before the listing, or tsc fails on it. Then check `Child.svelte.d.ts` and `x.svelte.d.ts` come out.
- The implementer plans the details.

## Docs

`docs/milestones/m6-library-build.md` (its risk line on plain `.svelte` files) and `docs/architecture.md` (library build
bullet).

## Done when

- The fixture library with a plain `src/Child.svelte` (importing a `.ucf` file) and a `src/count.svelte.ts` builds; the
  Svelte package ships both as source, with types, and its files compile with the real Svelte compiler.
- The test that expected the build error now expects the shipped files.
- The simplify-comments pass ran on every touched source file, committed on its own.
