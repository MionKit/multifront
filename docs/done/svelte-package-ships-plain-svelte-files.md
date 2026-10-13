---
type: feature
spec: guidelines
status: done
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

## Plan (approved 2026-10-13)

- core: `shipUcfImports(text, root, offset)` takes an offset (the block caller passes `block.contentStart`), exported
  from `@multifront/core` so a whole file uses it with `0`.
- vite, `library/targets.ts`: the svelte row runs `svelte({emitCss: false})`. A plain file's `<style>` ships inside its
  source and its compiled JS is dropped, so no CSS chunk reaches `libraryCss`. `.ucf` output never has component CSS.
- vite, `library/source.ts`: plain Svelte ids count as compiled (chunks and maps dropped); kept chunks point
  `Child.svelte.js` at `Child.svelte`. Each plain file the build reached is emitted as source:
  - `.svelte`: the library's `svelte.config.js` preprocessors (plugin-svelte's `loadSvelteConfig`), then `.ucf`
    specifiers rewritten.
  - `.svelte.ts`: types stripped with Vite's `transformWithOxc`, `.ucf` specifiers rewritten, shipped as `.svelte.js`.
  - `.svelte.js`: the same without the strip.
  - Its bare imports are checked like a component's; a plain file and a `.ucf` file written to one name fail.
- Every shipped `.svelte` file, `.ucf` components included, goes through those preprocessors (own commit). A `<script>`
  or `<style>` tag a preprocessor rewrote loses its `lang` and `type`, as svelte-package strips them.
- vite, `library/dts.ts`: a plain `.svelte` file is staged with its `.ucf` specifiers rewritten, unpreprocessed
  (svelte-package types from source too); Svelte's parse for that rewrite sees its `<style>` bodies blanked, since an
  SCSS body is no CSS. svelte2tsx's script is written beside every staged `.svelte` root (a file the build reached)
  before the listing run. A staged `Icon.svelte.ts` where `Icon.ucf`'s script goes fails the build: both would type
  as `Icon.svelte.d.ts`, the module reached at runtime or by a type-only import. With `dts: false` both ship.
- Plain files ship only when the build reaches them, and get no `exports` subpath.
- Tests, `packages/e2e/build/svelte-library.spec.ts`: the error test becomes a ships test, once with a `.svelte.ts` and
  once with a `.svelte.js` module (SCSS-only syntax preprocessed, compiled with the real compiler, types, no stray chunk
  or CSS, an unreached plain file left out, the index's `./Child.svelte` import kept); a plain file's alias import fails; a name clash fails;
  `vitePreprocess({script: true})` strips `lang="ts"` from a shipped component.
- Docs: `docs/milestones/m6-library-build.md` (6.8 and the risk line), `docs/architecture.md` (library build bullet),
  `publicdocs/06-building-a-library.md` (Svelte note, error table).
- Fuzzing: none; the only rewrite is core's `shipUcfImports`, already run over every `<svelte>` fixture.

## Decisions

- Every shipped `.svelte` file, components included, is preprocessed in this PR (orchestrator, answer (a)).

## Manual QA

Run on 2026-10-13 against `origin/main` at `f3d2bcb`. "Library copy" = `packages/e2e/fixtures/library` copied to
`packages/e2e/.tmp/qa-lib`, with `src/Child.svelte` (`<script lang="ts">`, imports `./Icon.ucf` and
`./count.svelte.js`, `<style lang="scss">`), `src/count.svelte.ts` (an interface, `$state`, a function), both exported
from `src/index.ts`, and a `svelte.config.js` with `vitePreprocess()`.

1. `pnpm devx test packages/e2e/build/svelte-library.spec.ts`: every test passes, "fails on a .svelte.ts module whose
   declaration is written where a component types ship" included. **Ran: pass, after the fix of #122.**
2. `pnpm devx test packages/e2e/consumer/sveltekit-plain-svelte.spec.ts`: 6 tests pass (mf-build, pack, fresh SvelteKit
   app, svelte-check, vite build, node server, Chromium). **Ran: pass.**
3. In the library copy, `node --conditions=source ../../node_modules/@multifront/vite/bin/mf-build.js --framework
   svelte`: `dist/svelte/` holds `Child.svelte` (`import Icon from "./Icon.svelte"`, `<style>` as plain CSS, no
   `lang="scss"`), `count.svelte.js` (no types), `Child.svelte.d.ts` (`label: string`), `count.svelte.d.ts`, and no
   `exports` subpath for either. **Ran: pass.**
4. Same build with `svelte.config.js` removed and a plain CSS `<style>`: builds, `Child.svelte` keeps `lang="ts"` and its
   CSS. With SCSS and no config: fails with plugin-svelte's "Did you forget to add a scss preprocessor?". **Ran: pass.**
5. Same build run from another folder with `--root .tmp/qa-lib`: the library's `svelte.config.js` still applies (the
   shipped `<style>` is CSS). **Ran: pass.**
6. `pnpm pack` in `dist/svelte`, copy `fixtures/apps/consumer-sveltekit`, `pnpm add <tarball>`, a page rendering `Child`
   and `double()`: `svelte-kit sync && svelte-check --fail-on-warnings` gives 0 errors 0 warnings; a page with
   `<Child labl="x" />` and `const n: string = count.value` gives exactly those 2 errors. Both with and without the
   library's `svelte.config.js`. **Ran: pass.**
7. In that app, `vite build`, then `PORT=4719 node build`: the HTML holds `<button class="child svelte-…">`; in Chromium,
   two clicks on it show `count` 2 and `double` 4, no console message; the built CSS holds `.child.svelte-…` with the
   SCSS color. **Ran: pass.**
8. Add `src/Icon.svelte.ts` beside `src/Icon.ucf`, export from it in the index, build: fails with `buildLibrary:
   src/Icon.ucf and src/Icon.svelte.ts would both be written as Icon.svelte.d.ts`. **Ran: pass, after the fix of #122.**
9. CI `svelte-floor` job on `main` (`peer-floor: @sveltejs/vite-plugin-svelte 7.1.1`): the plain-file and preprocess
   tests of `build/svelte-library.spec.ts` ran and passed. **Ran: pass (CI log, run 38445935187).**
10. Open the installed `node_modules/@mf-fixture/ui-svelte/Child.svelte` and a page using it in VS Code with the Svelte
    extension: hover on `<Child label>` shows `label: string`, no red squiggle. **needs a person.**
