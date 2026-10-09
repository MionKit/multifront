# create-todo: investigate (step 4)

Match depth to the user's step 3 choice.

**Guidelines: superficial, just enough to be correct.** Goal: accurate, actionable pointer, not a solution.

- Verify the premise: problem real (or feature makes sense), named files / functions / symbols exist roughly where
  you say (a couple of quick greps), nothing obvious makes it a dead end.
- Touches the design → name which of `docs/spec.md`, `docs/plan.md`, `docs/architecture.md` (+ section) changes.
  A grep, not design work.
- Then stop. Never design the solution, enumerate edge cases or write a test plan: implementer re-derives current
  state anyway, so doing it here wastes the work twice.

**Full plan: planner-grade, with an independent planning agent.**

- Read the code, pin exact call sites (`file:line`), design the approach, list the concrete changes.
- Test plan (package, what it pins), docs impact.
- Feature → fuzzing candidate? Cheap oracle: round-trip, determinism, compare-to-a-trusted-source.
- Draw **Out of scope** explicitly + a concrete **Done when**.
- Large surface → spawn an independent research or planning agent (tool mapping).
- Aim: `implement-todo` builds from your doc with minimal re-investigation.
