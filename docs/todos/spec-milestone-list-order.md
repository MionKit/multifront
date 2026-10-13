---
type: docs
spec: guidelines
status: ready
created: 2026-10-13
---

# Spec milestone list puts Library build before the Svelte target

## Intent

`docs/spec.md` section 9 "Milestones" lists "5. Library build" then "6. Svelte target". Every other doc runs them the
other way: `docs/milestones/README.md` (5. Svelte target, 6. Library build), `docs/plan.md` ("### 5. Svelte target",
"### 6. Library build"), the M6 milestone doc ("It comes after the three targets (M3, M4, M5)") and spec section 11
itself ("tested in M5" for the Svelte tsserver plugin). The spec's Library build item also names only two consumer
apps (Next.js App Router, Vite React), while the milestone shipped four (plus Vite Vue and SvelteKit). A reader of the
spec gets the wrong order and the wrong consumer list.

## Direction

- Swap items 5 and 6 in spec section 9 so Svelte target is 5 and Library build is 6.
- Library build item: say it builds all three targets (React, Vue, Svelte) and is verified in four fresh apps:
  Next.js App Router, Vite React, Vite Vue, SvelteKit.
- Check spec section 10 "Library consumers" line against the same four apps.
- The implementer reads the M6 milestone doc for the shipped facts and plans the exact wording.

## Docs

- `docs/spec.md` sections 9 and 10 only. `docs/plan.md`, `docs/architecture.md` and the milestone docs already match.

## Done when

- Spec section 9 order matches `docs/milestones/README.md` and `docs/plan.md`, and the Library build item names the
  four consumer apps.
- No source file touched, so no comment pass.
