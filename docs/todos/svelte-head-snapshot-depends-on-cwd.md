---
type: fix
spec: guidelines
status: ready
created: 2026-10-13
---

# The Svelte head snapshot of core's block tests depends on where vitest starts

## Intent

`packages/core/test/blocks/svelte.spec.ts`, "renders every element from the block with the scope once and only module
class names", fails for `svelte/shapes/SpecialElements.ucf` when vitest starts from `packages/core`
(`pnpm exec vitest run test/blocks/svelte.spec.ts`), on `main` too. From the repo root (`pnpm devx test`, CI) it passes.
The rendered `<svelte:head>` comment hash differs (`<!--19p0f6f-->` vs `<!--hxl29t-->`). A test that passes or fails
by working directory misleads anyone running one package's tests.

## Direction

- The server render compiles with `filename: ctx.filename + '.svelte.svelte'` (`serverModule` in
  `packages/core/test/svelte/render.ts`). Svelte derives the head hash from that filename relative to its `rootDir`
  option, which defaults to `process.cwd()`.
- Likely fix: pass a fixed `rootDir` (the repo root or the fixtures folder) to that `compile` call, so the hash no longer
  follows the cwd; then check the snapshot still matches from both places.
- The implementer confirms the cause and plans the details.

## Docs

None: test-only change.

## Done when

- The block tests pass started from `packages/core` and from the repo root, with the snapshot unchanged.
- The simplify-comments pass ran on every touched source file, committed on its own.
