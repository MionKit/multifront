---
type: chore
spec: guidelines
status: ready
created: 2026-10-16
---

# Investigate a kept on-disk cache of split `.ucf` block files

## Intent

Find out if each block of a `.ucf` file should be written once as a real file on disk and kept, so linters and
any other file-based tool can read it. This is research: the output is a written recommendation, not a build.

Why: a tool that only reads files from disk cannot see inside `.ucf`. Today each tool needs its own workaround.

What is true today (checked in the code):

- Nothing keeps block files. `mf-lint` (`packages/language-tools/src/lint/index.ts`, `lintGroup`) writes each
  `<react>`/`<vue>`/`<svelte>` block to a fresh temp folder under the OS temp dir on every run
  (`Card.ucf.react.tsx`, `Card.ucf.vue.vue`, `Card.ucf.svelte.svelte`), runs oxlint, maps spans back, then
  deletes the folder.
- The Vite plugin's cache (`packages/vite/src/cache.ts`) lives in memory only.
- One precedent for the place: the library type build stages `src/` under `node_modules/.cache/multifront/` and
  runs tsc there (`packages/vite/src/library/dts.ts`, `withStage`), rewriting `.ucf` import specifiers
  (`packages/vite/src/library/specifiers.ts`). That stage is still fresh per build and deleted after.
- oxlint cannot read `.ucf` itself: its file types are hard-coded. `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`
  fails the day that changes.

## Direction

The investigation answers each question below. The implementer plans the details.

1. **Where the files live.** `node_modules/.cache` (tools skip `node_modules` by default; config lookup walks up
   from the file, so it finds the root config, not a nested one) vs beside the source (clutter, git, tools see
   duplicates) vs a mirrored tree somewhere else.
2. **Imports.** Relative imports (`../utils`, `./Button.ucf`) resolve from the file's folder. So a cache must
   mirror the source tree and rewrite `.ucf` specifiers, as the type build does.
3. **Staleness.** Who rewrites the cache on each edit: the editor buffer vs disk, the language server, Vite, the
   CLIs. How a tool never reads an old copy.
4. **Mapping back.** Each tool still reports positions in the generated file, so mapping per tool stays. What a
   kept cache saves over the per-run temp folder (splitting is cheap).
5. **What it unlocks.** Rules across files (import/no-cycle), lint that needs types, other file-based tools.
   Whether that is worth the cost.

A short prototype timing (temp folder per run vs kept cache, on a real fixture app) is welcome if it helps decide.

## Docs

None during the investigation. If the answer is "do it", the follow-up build todo names the `docs/architecture.md`
and `docs/plan.md` sections it changes.

## Done when

- A written recommendation: do it or not, and which layout, with the reasons per question above.
- A prototype measurement attached if one was useful.
- If the answer is "do it", a follow-up build todo is filed.
- The simplify-comments pass ran on every touched source file, committed on its own (none if no source changed).
