---
type: fix
spec: guidelines
status: ready
created: 2026-10-13
---

# Library output names that differ only by case pass the name clash checks

## Intent

`buildLibrary()` fails when two files of `src` would be written to one name: two chunks in `buildOne`'s `fileName`
(`packages/vite/src/library/build.ts`), a plain Svelte file and a component in `librarySource()`
(`packages/vite/src/library/source.ts`), a `.svelte.ts` module and a component's `.d.ts` in `emitSvelteTypes`
(`packages/vite/src/library/dts.ts`). Every check compares names case-sensitively. `src/icon.svelte.ts` beside
`src/Icon.ucf`, or `src/card.ts` beside `src/Card.ucf`, builds green on Linux. Unpacked on macOS or Windows
(case-insensitive file systems), one file overwrites the other and the package is broken there only.

## Direction

- Compare output names case-insensitively in each of those checks, keeping the names as written in the error message.
- Decide whether a case-only clash is the same error (`... would both be written as ...`) or a message of its own.
- The implementer plans the details.

## Docs

`docs/milestones/m6-library-build.md` (6.1 and 6.8 build errors) and `publicdocs/06-building-a-library.md` (error
table) if the message differs.

## Done when

- A fixture library copy with a case-only clash fails each check, in `packages/e2e/build/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
