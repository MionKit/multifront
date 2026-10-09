# create-todo: doc shape (step 6)

What `docs/todos/<slug>.md` holds. Write it only after step 5 approval.

- `<slug>`: short kebab-case from the title, no collision with existing files.
- Slug reads like the title, never a bare number like `todo-3`:
  user recognizes it by filename in the `implement-todo` picker.
- `created`: today's absolute date, matching the existing todos' convention.

```markdown
---
type: <fix | feature | docs | chore>
spec: <full-plan | guidelines>
status: ready
created: <YYYY-MM-DD>
---

# <Concise title>
```

Body by `spec`:

- **Guidelines**, lean:
  - `## Intent`: what + why.
  - `## Direction`: rough approach + verified pointers / constraints; say plainly the implementer plans the details.
  - `## Docs`: which of `docs/spec.md`, `docs/plan.md`, `docs/architecture.md` (+ graphics) change, + section;
    or "none, because …". A `publicdocs/` page only when it already describes behaviour this changes:
    new public pages come from the milestone's docs writer.
  - `## Done when`: the rough acceptance bar.
- **Full plan**: shape every full-plan spec in `docs/todos/` follows (open any with `spec: full-plan` to see it):
  - `## Problem`, `## Plan` (or `## Fix direction`) with `file:line` pointers, `## Tests`, `## Docs`,
    `## Fuzzing` (if a feature), `## Out of scope`, `## Done when`.
  - `## Tests` says where each test runs + what it needs: host + CI. Check infra is really there
    (`.github/workflows/ci.yml`, SETUP.md); never assume it.
  - Test needs a missing piece (browser, VS Code, packed tarballs) → plan builds it in this todo,
    per "Test infrastructure" in `docs/milestones/README.md`.
- Every `## Done when` ends with the comment pass:
  "the simplify-comments pass ran on every touched source file, committed on its own".
  No opt-out short of a branch that touched no source file.
