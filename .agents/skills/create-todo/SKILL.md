---
name: create-todo
description: File a request as a docs/todos/ spec, never implement it. Use when asked to note, file or add a todo.
---

# create-todo

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

Capture a request as a clean, self-contained spec under `docs/todos/`, where `implement-todo` picks work from.

- Output: ONE markdown doc, never a code change. Always opens with the metadata header below.
- Body: a **full, ready-to-build plan**, or **light guidelines** leaving real planning to the implementer.
- Which one = user's call. Guidelines is the usual answer.
- **Run by a milestone step agent** (run-milestone skill): orchestrator = user, spec always `full-plan`,
  approval = its reply to your `PLAN` message.

## ⚠️ The gate

- Nothing written to disk until the user approves the drafted todo. Capturing, classifying, investigating = analysis.
- Not in plan mode → enter it once the request is captured (Claude: EnterPlanMode; Codex: plan mode if available).
  Investigation stays read-only, approval explicit.

## Metadata header (contract with implement-todo)

Every todo starts with YAML frontmatter (template: [doc-shape.md](doc-shape.md)).
`implement-todo` reads `type` + `spec` to decide how to treat the todo.

- `type` (load-bearing): `fix` (corrects wrong behavior), `feature` (new capability), `docs` (documentation only),
  `chore` (refactor / tooling / infra, no user-facing behavior change).
- `spec` (load-bearing): `full-plan` = complete plan, implementer builds directly.
  `guidelines` = direction + intent, implementer investigates + plans first.
  Get it right: `implement-todo` switches on it.
- `status` (conventional): `ready` | `blocked` | ...
- `created` (conventional): today, absolute (`2026-07-22`, not "today"): relative dates rot.

## The arc

1. **Capture** the request: the idea + the *why*.
2. **Classify** the `type`: decide yourself; ask only if genuinely unsure.
3. **Ask** the user: full plan, or guidelines? (Usually guidelines.)
4. **Investigate** to matching depth: superficial for guidelines, planner-grade for a full plan.
   Detail: [investigate.md](investigate.md). Read before investigating.
5. **Present** the drafted todo for approval (approval workflow).
6. **Write** the doc to `docs/todos/<slug>.md` on approval: header + body.
   Slug, header template, body per `spec`: [doc-shape.md](doc-shape.md). Read before writing.
   Close: tell the user where you filed it; they can pick it up any time with `implement-todo`.

## Step 1: Capture

- Get the intent + reason, not a restatement. A good todo tells a future reader *why it is worth doing*.
- Terse line ("dedup the union guard") → draw out the missing why + constraints the user has in mind.
- Keep it short: recording a request, not solving it.
- Check it exists: quick look across `docs/todos/` + `docs/done/` for the topic.
  Match → surface it, never file a duplicate. User may reopen or extend the existing one.

## Step 2: Classify the type

- Decide `type` yourself: the default. Usually obvious from the request.
- Genuinely ambiguous (e.g. "improve X": bug fix or new capability?) → ask with the question tool.
- State the classification when you summarize.

## Step 3: Full plan or guidelines?

Always the user's choice: ask with the question tool. Lead with guidelines: the common case, and the point of the
two-skill split (capture direction now, implementer plans deeply at build time with fresh context).

- **Guidelines** (usual): record intent + direction; `implement-todo` investigates + plans later.
- **Full plan**: deep planning now, spec ready to build from. Only when the user wants the thinking done up front.
- Asked the `type` question in step 2 → fold both into one question-tool call.

## Step 5: Present for approval

- Show the exact todo (frontmatter + body) via the approval workflow in [the tool mapping](../TOOLS.md).
  Full plan = planner-grade content; guidelines = short version.
- User may amend type, spec choice, direction, wording. Fold in edits, re-present on change. No file before approval.

## Never

- Implement anything. This skill writes exactly one file: the todo. Work wanted now → `implement-todo`.
- Write the file before approval. Steps 1 to 5 = analysis.
- Over-investigate a guidelines todo: deep planning is the implementer's job.
- Omit or guess `type` / `spec`: a missing or wrong `spec` sends the implementer down the wrong path.
- Link a specific `docs/todos/` or `docs/done/` file from any other doc, skill, workflow or code comment
  (root AGENTS.md rule): put the reasoning in the referencing file.
  In the todo you write too: describe the shape, never cite a sibling spec.
- Answer the spec question for the user.

## Gotchas

- `spec: guidelines` = common case, not a lesser one: capture direction cheaply, implementer plans with fresh context.
- `implement-todo`'s found-a-bug follow-ups land here in this shape: usually `type: fix`, `spec: guidelines`.
