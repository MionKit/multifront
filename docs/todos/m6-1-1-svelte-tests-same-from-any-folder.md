---
type: fix
spec: full-plan
status: ready
created: 2026-10-14
milestone: 6.1
step: 6.1.1
---

# Milestone 6.1.1: Svelte block tests give the same result from any folder

## Problem

`serverModule` in `packages/core/test/svelte/render.ts:63` compiles each built `.svelte` file with
`svelte.compile(file.code, {generate: 'server', filename: `${ctx.filename}.svelte.svelte`})` and no `rootDir`.
Svelte 5 hashes the `<svelte:head>` marker comment from the filename made relative to `rootDir`
(`svelte/src/compiler/phases/3-transform/server/visitors/SvelteHead.js:19`, `state.js:161-170`), and `rootDir` defaults
to `process.cwd()` (`validate-options.js:17`). So the test "renders every element from the block with the scope once
and only module class names" for `svelte/shapes/SpecialElements.ucf` (`packages/core/test/blocks/svelte.spec.ts:345`)
matches its snapshot `<!--19p0f6f-->` from the repo root and gets `<!--hxl29t-->` from `packages/core`.
Confirmed: 1 failed from `packages/core`, 296 passed from the root. No other core test differs by folder (full core
suite from `packages/core`: only this one fails).

## Plan

- `packages/core/test/svelte/render.ts`: pass `rootDir: REPO_ROOT` to that `svelte.compile` call, with
  `const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..')` (same derivation as `packages/core/test/compilers.spec.ts:12`)
  and a one-line comment: Svelte hashes the `<svelte:head>` marker from the filename relative to `rootDir`, cwd by default.
- Repo root, not the fixtures folder: it is the folder the snapshot was written from, so the snapshot stays byte for
  byte unchanged. Svelte turns `\` into `/` in both the filename and `rootDir`, so the relative path, and the hash,
  are the same on Windows.
- The other `svelte.compile` calls in core tests (`blocks/svelte.spec.ts:74,134,214,267`, `svelte/forward.spec.ts:89`)
  check only warnings, a throw or `css === null`: no output that depends on the folder. Left as they are.
- Regression guard (see Decisions): the core suite also runs from `packages/core`, in CI and in `pnpm devx check`.
  - `.github/workflows/ci.yml`, `check` job: a step right after "Test", `pnpm exec vitest run` with
    `working-directory: packages/core`.
  - `scripts/devx.mjs`, `check`: runs the same command from `packages/core` after `test`.
  - `scripts/lib/registry.mjs`: the `check` summary names the new part.

## Tests

- `packages/core/test/blocks/svelte.spec.ts`, unchanged, no snapshot update:
  - from `packages/core`: `pnpm exec vitest run test/blocks/svelte.spec.ts`, green (red before the fix);
  - from the root: `pnpm devx test`, green.
- The guard makes CI's `check` job and `pnpm devx check` run the whole core suite from `packages/core`, so a test that
  depends on the folder fails the gate. Runs on this host and in CI (`check` job, ubuntu).

## Docs

- `SETUP.md`: the `pnpm devx check` line names the core run from its folder.
- `docs/milestones/README.md`, "Test infrastructure": one row for the new `check` step.
- Spec, architecture, public docs: none, test-only.
- Milestone doc: `- Status: done` on 6.1.1.

## Fuzzing

Not a candidate: a one-option fix in a test helper, no feature.

## Decisions

- Guard: a `check` job step after "Test" running `pnpm exec vitest run` in `packages/core`, and `pnpm devx check` runs
  the same, its registry summary and the SETUP.md line updated (orchestrator: the milestone exit test names that
  command; `check` = "everything CI runs", so both run it).

## Out of scope

- Other packages' suites from their own folder: they already pass (language-tools, vite, e2e build / editor / devx).
- `packages/vscode` holding a vitest project with no test files.
- Any change to Svelte compile options in `src/` (the Vite path uses plugin-svelte's own options).

## Done when

- `pnpm exec vitest run test/blocks/svelte.spec.ts` in `packages/core` and `pnpm devx test` at the root are both green,
  with no snapshot file changed.
- CI's `check` job and `pnpm devx check` run the core suite from `packages/core`.
- `pnpm devx check` passes. The simplify-comments pass ran on every touched source file, committed on its own.
