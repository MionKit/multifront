---
type: fix
spec: guidelines
status: ready
created: 2026-10-16
---

# mf-tsc gives wrong types to a file that imports one `.ucf` file in two frameworks

## Intent

`packages/e2e/fixtures/apps/all-targets/src/main.tsx` and `apps/root-props/src/main.ts` import the same `.ucf` file
`with {framework: 'react'}`, `'svelte'` and `'vue'`. TypeScript keeps one resolution per (specifier, mode) in a file,
so every one of those imports gets the last one's types: `mf-tsc` reports TS2786 / TS2345 / TS2769 there (plus our
`mixed-frameworks` warning), though the Vite build is right. The gate (`packages/e2e/editor/gate.spec.ts`, its
`tsconfig.fixtures.json`) leaves both files out for that reason.

`docs/plan.md` (spike 1, answer 2) records the limit and its fix, a re-export file per framework, but spec 5 and
`docs/architecture.md` do not state it, so a user of `mf-tsc` cannot know it. Found while building the gate.

## Direction

- State the limit in spec 5 (editor and `mf-tsc`), with the re-export fix the `mixed-frameworks` warning names.
- Then decide for the two fixture apps: give them one re-export file per framework, so they type-check and leave the
  gate's excludes, or keep them as the build's own cases. Their browser and HMR tests (`all-targets` drives the HMR
  specs) must keep passing; check what a re-export module changes there. The implementer investigates and plans.

## Docs

spec 5; `docs/architecture.md` if the editor section names the limit; the gate's exclude comment.

## Done when

- The limit is in the spec, and each of the two files either type-checks in the gate or stays left out with the
  spec's reason.
- The simplify-comments pass ran on every touched source file, committed on its own.
