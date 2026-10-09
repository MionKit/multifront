---
name: implement-todo
description: Build a docs/todos/ spec: plan, gate, review, PR, green CI. Use when asked to implement or pick a todo.
---

# implement-todo

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

Carry one `docs/todos/` spec through planning, build, review, comment pass, open PR, green CI.
Job ends when the PR is open and green, not before.

- Specs range from full plans (Problem / Plan / Tests / Done-when, real `file:line` pointers) to loose pointers.
- Tell which kind you have, fill gaps, get an **approved plan** before code, build to the spec's own "Done when" bar.

## Modes

Asked once in step 1. Planning (steps 1 to 6) asks the user questions in BOTH modes.
Mode decides only what follows approval.

- **Automatic**: steps 7 to 12 run with no more questions until PR open + CI green.
- Automatic, a step would ask → decide yourself, pick the safer option, list each such decision in the final message.
- Automatic → review runs in its automatic mode.
- **Manual**: user stays in the loop. Forks are asked. Review runs in reviewed-by-you mode: user picks what to fix.
- **Run by a milestone step agent** (run-milestone skill): orchestrator = user, mode = automatic.
  Its `APPROVED` on the todo = plan approval. Its step.md lists the changes to steps 7 to 12.

## ⚠️ The one hard gate

- No file edits until the user approves a plan through the approval workflow.
- Steps 1 to 6 = reading, investigating, asking. Analysis only. Step 7 starts only after approval.
- Not in plan mode → enter it after the todo is chosen (Claude: EnterPlanMode; Codex: plan mode if available).
  Invariant then holds by construction, questions read as planning, user sees what you intend before you build.

## The arc

1. **Pick** the todo (question tool, unless the user named one) + **ask the mode**.
2. **Read** it fully + **summarize** it back to the user.
3. **Classify** from metadata `spec`: ready-to-build plan, or guidelines to plan from?
4. **Decide** the tests / docs / fuzzing obligations.
5. **Refine** open questions with the user (only if investigation left forks).
6. **Present the plan** for approval: always, even for a complete spec.
7. **Implement** to the plan + the spec's Done-when.
8. **Gate + finish**: tests green, docs updated, spec reconciled with what shipped, then `git mv` into `docs/done/`.
9. **Review**: review-pr skill over the branch, findings fixed.
10. **Comment simplification**: `comments-simplifier` subagent runs simplify-comments over every touched source file.
    Always, never by you.
11. **Open the PR**.
12. **Drive CI to green**.

- Steps 1 to 6 detail: [plan.md](plan.md). Read before step 1.
- Steps 7 to 12 detail: [ship.md](ship.md). Read before step 7.

## Never

- Edit any file before the plan is approved.
- Skip tests on a fix or a feature: the gate rejects it, so do you.
- Add fuzzing without asking, or hand-roll the fuzzer: route to the fuzzy-testing skill.
- Pull candidates from `docs/done/`: only `docs/todos/` holds ready work.
- Exceed the todo's stated Out of scope. Leave the finished spec sitting in `docs/todos/`.
- Skip the review. Open the PR before the review + the comment pass are committed.
- Stop at an open PR: a red check or a conflict = todo not done.
- Skip the comment pass, run it in this session, or accept a result that changed a fact.
- Bypass `comments-simplifier` for a one-comment change. Only exception: branch touched no source file.
- Commit its report unreviewed: check it against the code, line by line.
- Let an *unrelated* issue end as a filed-and-forgotten spec → [delegate-finding skill](../delegate-finding/).
  A spec only for what truly cannot land in either lane: a commitment to finish, not a way to close the loop.
- Move a diverged spec unchanged: update the todo to what shipped before `git mv` to `docs/done/`.
- Reference a todo or done doc from any other file (docs, skills, workflows, code comments): specs get deleted.
  Write the reasoning where needed. A list of docs that may go stale after merge lives in the spec itself.
- Answer the planning questions for the user. Only after approval, only in automatic mode, decide yourself.
