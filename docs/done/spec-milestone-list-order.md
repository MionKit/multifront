---
type: docs
spec: guidelines
status: done
created: 2026-10-13
---

# Spec milestone list puts Library build before the Svelte target

## Intent

`docs/spec.md` section 9 "Milestones" lists "5. Library build" then "6. Svelte target". The plan docs run them the
other way: `docs/milestones/README.md` (5. Svelte target, 6. Library build), `docs/plan.md` ("### 5. Svelte target",
"### 6. Library build"), the M6 milestone doc ("It comes after the three targets (M3, M4, M5)") and spec section 11
itself ("tested in M5" for the Svelte tsserver plugin). The spec's Library build item also names only two consumer
apps (Next.js App Router, Vite React), while the milestone shipped four (plus Vite Vue and SvelteKit). A reader of the
spec gets the wrong order and the wrong consumer list. The milestone docs m1 to m4 and the READMEs carried the same
old order or a target list without Svelte (found while planning).

## Direction

- Swap items 5 and 6 in spec section 9 so Svelte target is 5 and Library build is 6.
- Library build item: say it builds all three targets (React, Vue, Svelte) and is verified in four fresh apps:
  Next.js App Router, Vite React, Vite Vue, SvelteKit.
- Check spec section 10 "Library consumers" line against the same four apps.
- The implementer reads the M6 milestone doc for the shipped facts and plans the exact wording.
- Widened at approval: every doc, not only the spec (see the Plan section below).

## Docs

- `docs/spec.md` sections 9 and 10, milestone docs m1 to m4, the root and package READMEs, `packages/AGENTS.md`.
  `docs/plan.md`, `docs/architecture.md`, `docs/milestones/README.md` and m5 to m7 already match.

## Done when

- Spec section 9 order matches `docs/milestones/README.md` and `docs/plan.md`, and the Library build item names the
  four consumer apps.
- No source file touched, so no comment pass.

## Plan: every doc (approved 2026-10-13)

The user widened the scope: fix every doc, not only the spec, so milestone order and the targets built match what
shipped (M5 Svelte target, M6 Library build for React, Vue and Svelte, four consumer apps).

Shipped:

- `docs/spec.md`: section 9 lists Svelte target as 5 and Library build as 6; the Library build item names the three
  targets and the four fresh apps (Next.js App Router, Vite React, Vite Vue, SvelteKit). Section 10's consumer line
  names the same four apps.
- Milestone docs: m1 and m3 stop calling the Svelte work milestone 6 ("3, 4 and 5", "4 and 5"); m1 and m2 list M5
  before M6; m4 points at step 5.11 (Svelte's own editor setup), not 6.11.
- Root `README.md`: the example gains a `<svelte>` block; the Vite plugin row names plugin-vue, plugin-react,
  plugin-svelte and `mf-build`. `packages/vite/README.md` says the same.
- `packages/vscode/README.md`: `.svelte` importers need Svelte for VS Code and a `rootDirs` entry.
- `packages/AGENTS.md`: `@multifront/vite` carries vite and each framework with its plugin.

Already correct and left alone: `docs/plan.md`, `docs/architecture.md`, `docs/milestones/README.md`, m5 to m7,
`publicdocs/`, the graphics. No source file touched: no tests, no comment pass.
