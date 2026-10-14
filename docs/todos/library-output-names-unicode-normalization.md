---
type: fix
spec: guidelines
status: ready
created: 2026-10-14
---

# Library output names that differ only by Unicode normalization

## Intent

macOS (APFS) ignores Unicode normalization in file names: `Café.ucf` written in NFC (`é` as one code point) and the
same name in NFD (`e` plus a combining accent) are one file there. `buildLibrary()`'s output name checks
compare names ignoring case only (`fileKey()` in `packages/vite/src/library/names.ts`), so two `src` files whose
output names differ only by normalization build green on Linux and Windows, and one overwrites the other once the
package is installed on macOS. Rare, but silent when it happens.

## Direction

- Every name clash check goes through `fileKey()` (chunk names in `build.ts`, shipped Svelte sources and the scope
  helper in `source.ts`, Svelte `.d.ts` names in `dts.ts`, `styles.css` in `css.ts`). Normalizing there
  (`name.normalize('NFC').toLowerCase()`) likely covers all of them at once.
- The case-only messages say "which macOS and Windows see as one file". Windows (NTFS) does not ignore normalization,
  so a normalization-only clash needs its own wording (macOS only). The implementer decides the message.
- Test beside the case-only clash tests in `packages/e2e/build/library.spec.ts`: a fixture copy with an NFC and an
  NFD name. A file name in NFD may not survive every host's file system as written: check what Linux CI and a
  macOS host keep before choosing the fixture.

## Docs

- `docs/milestones/m6-library-build.md` build errors, if the rule changes there.
- `publicdocs/06-building-a-library.md` "Fixing a Failed Build" table: a row for the new message.

## Done when

- Two `src` files whose output names differ only by Unicode normalization fail the library build with a clear
  message, on every OS, pinned by a fixture-copy test.
- The simplify-comments pass ran on every touched source file, committed on its own.
