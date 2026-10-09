---
name: implement-todo
description: Build a docs/todos/ spec end to end, from an approved plan to the gate, docs/done/, the review-pr review, the comment simplification pass, the PR, and a green CI. Use when the user wants to implement or pick a todo.
---

# implement-todo

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

Take one spec from `docs/todos/` and carry it through its whole life cycle: planning, building, review, simplification, an open PR, and a green CI. The job ends when the PR is open and green, not before.

**Two modes, asked once in step 1.** Planning (steps 1 to 6) always asks the user questions, in both. The mode only decides what happens after the plan is approved:

- **Automatic**: steps 7 to 13 run on their own, with no more questions, until the PR is open and CI is green. Where a step would ask, you decide, pick the safer option, and list each such decision in the final message. The review runs in its automatic mode.
- **Manual**: the user stays in the loop. Forks are asked, and the review runs in its reviewed-by-you mode, so the user picks what to fix. The specs in that directory range from full plans (Problem / Plan / Tests / Done-when with real `file:line` pointers) to loose pointers and open questions. Your job is to figure out which kind you have, fill any gaps, and get an **approved plan** before touching code — then build it to the spec's own "Done when" bar.

**Run by a milestone step agent** (the run-milestone skill): the orchestrator is the user, the mode is automatic, and its `APPROVED` on the todo is the plan approval. Its step.md lists the changes to steps 8 to 12.

**The one hard gate: no file edits until the user has approved a plan through the approval workflow.** Everything in steps 1-6 is reading, investigating, and asking — analysis only. Implementation (step 7) starts only after approval. If you are not already in plan mode, enter it (Claude: EnterPlanMode; Codex: plan mode if available) after the todo is chosen so the invariant holds by construction and your clarifying questions read as planning.

## The arc

1. **Pick** the todo (the available question tool, unless the user already named one), and **ask the mode**.
2. **Read** it fully and **summarize** it back to the user.
3. **Classify** from the metadata `spec`: a ready-to-build plan, or guidelines you must plan from?
4. **Decide** the tests / docs / fuzzing obligations.
5. **Refine** open questions with the user (only if investigation left forks).
6. **Present the plan** for approval — always, even for a complete spec.
7. **Implement** to the plan and the spec's Done-when.
8. **Gate + finish**: tests green, docs updated, the spec reconciled with what actually shipped, then `git mv` into `docs/done/`.
9. **Review**: the review-pr skill runs over the branch and its findings are fixed.
10. **Comment simplification**: the `comments-simplifier` subagent runs the simplify-comments skill over every source file this change touched. Always, never by you.
11. **Open the PR**.
12. **Drive CI to green**.

## Step 1 — Pick the todo and the mode

The source is **`docs/todos/*.md` only**. The sibling dirs are not candidates: `docs/done/` is finished. Ignore `.gitkeep`.

- **If the user already named a todo** — a filename, a path under `docs/todos/`, or an unambiguous description ("the union guard dedup one") — skip the question, confirm which file you landed on, and move to step 2.
- **Ask the mode** in the same question round (or its own if the user named the todo): automatic or manual, as described above.
- **Otherwise ask with the available question tool.** Question tools have different option limits, and there are often more todos than that, so: first list **every** todo in prose (one line each — filename, a one-line gist, and its status if the file states one like `READY`), then offer a curated set as options (prefer the `READY`/next-release ones) with free-text input covering the rest of the listed set. That way the user sees the full menu even though only a few are one-click.

## Step 2 — Read it fully, then summarize

Start with the **metadata header**. Todos written by `create-todo` open with YAML frontmatter carrying `type` (`fix` | `feature` | `docs` | `chore`) and `spec` (`full-plan` | `guidelines`) — those two fields drive everything downstream, so read them first.

**The header is optional.** Older todos, and anything filed by hand, may not have one. When it is missing, derive what it *should* be — `type` and `spec` from the doc's prose (its Status line and shape), plus `status`/`created` — and plan to **write that header back into the file** so the next run reads it directly instead of re-deriving. That write happens after approval, alongside the other doc edits in step 7; nothing is written before the plan is approved.

Then read the whole file, following enough of its internal `file:line` pointers to actually understand the change (these specs cite the exact functions to touch). Give the user a short summary:

- **What** the todo is and **what kind** it is — take the kind from `type`, or infer it: a bug fix, a feature, a docs change, or a chore/refactor.
- Its **status**, and — if present — its own **Done when** and **Out of scope** sections. Those are gold: they set the acceptance bar and the boundaries the author already drew. Honor them; do not silently widen scope past an explicit "Out of scope".

## Step 3 — Classify: ready-to-build plan, or guidelines to plan from?

The metadata `spec` field is the signal — it is the switch `create-todo` set when the todo was filed:

- **`spec: full-plan`** — the body is a complete plan (concrete Problem / Plan / Tests / Done-when, real file pointers). Plan directly from it; just confirm the cited `file:line` locations are still current, since code drifts.
- **`spec: guidelines`** — the body is direction and intent only, and the deep planning was deliberately left to you. Investigate now: read the referenced code, grep for the real call sites, and for anything broad spawn an independent research or planning agent using the tool mapping. Resolve the unknowns so your plan rests on facts, not guesses.
- **No header (older todos)** — judge from the shape instead: a full Problem/Plan/Tests/Done-when with real pointers reads as `full-plan`; a loose pointer or a list of "figure out X" reads as `guidelines`.

Either way you will present a plan in step 6 — the `spec` only decides **how much digging precedes it**.

## Step 4 — Decide the tests / docs / fuzzing obligations

The header's `type` orients this: a `fix` or `feature` always needs tests, a `docs` todo may need none, and only a `feature` gets the fuzzing check. Work the specifics while planning.

**Tests — required for every fix and every feature.** This is a rule, not a judgment call: the repo's PR-readiness gate does not accept an untested fix or feature. Work out the layer while planning:
- Vitest (`.spec.ts`) in the package's `test/` dir, mirroring `src/`.
- A new block kind or operation → a test per row of the grid it touches (see `docs/architecture.md`).
- A pure docs or chore todo may legitimately have no code test — say so explicitly rather than skipping silently.

**Docs — decide when the answer is clear, ask when it is not.** The docs are `docs/spec.md` (what), `docs/architecture.md` (how the pieces fit, with its graphics) and `docs/plan.md` (in which order). A change to behaviour, structure or order updates the matching one. If you cannot tell, **ask** (the available question tool). Name the file AND the section in the plan. A changed graphic means editing its HTML under `docs/assets/src/` and running `pnpm devx docs-images`.

**Fuzzing — for features, judge candidacy, then propose.** Much of multifront rewrites text and keeps offsets (the block splitter, the scope step, the position maps), and that kind of code usually has a cheap correctness oracle that makes fuzzing pay off. Quickly gut-check the feature for one:
- **round-trip** (an encode/decode or serialize/parse pair should return the value),
- **do-it-twice / determinism** (same input, same output, e.g. the same scope id on every machine),
- **compare-to-a-trusted-source** (one implementation checked against another, e.g. a block's offsets against `source.slice`),
- **reject-bad-input** (malformed input is always rejected, never mis-accepted).

If the feature has one of these, **propose fuzzing with the available question tool and get a yes before baking it into the plan** — do not add it unilaterally, and do not design the fuzzer here. Hand the actual design off to the **fuzzy-testing** skill, which drives the discovery properly. If nothing gives a cheap oracle, say so and move on; talking a feature out of fuzzing is a fine outcome.

## Step 5 — Refine open questions (only if needed)

If investigation (step 3) or the docs/fuzzing decisions (step 4) left genuine forks — a design choice the spec did not settle, an ambiguity the code does not answer — resolve them with the user now, one focused question at a time. Do not ask what you can determine yourself by reading the code; ground every question in what you found.

## Step 6 — Present the plan for approval (always)

Present the plan with the approval workflow in [the tool mapping](../TOOLS.md), even when the todo was already a complete spec — the user gets to amend before any code is written. The plan should state, concisely:

- the change you will make (and the key files, from the spec's own pointers),
- the **test** plan (which package, and what the tests will pin),
- the **docs** plan (which page, and existing section or new section; or an explicit "no docs needed because …"),
- the **fuzzing** decision (proposed + confirmed, or "not a fuzz candidate because …"),
- the **finish**: run the gate, then `git mv` the spec into `docs/done/`.

Mirror the todo's own **Done when** so approval is measured against the author's bar. Wait for approval. If the user amends, fold it in and re-present.

## Step 7 — Implement (after approval only)

- **Branch check first.** The repo lands work on a feature branch, never `main` (see the Git workflow in [AGENTS.md](../../../AGENTS.md)). If you are on `main`, create a branch before editing.
- **Record the plan in the todo doc before building:**
  - **Backfill a missing header.** If step 2 found no frontmatter, write the derived `type` / `spec` / `status` / `created` block to the top of the file now, so the doc is normalized for the next run and for the `docs/done/` archive.
  - **For a `guidelines` todo, append the approved plan** as a new section at the **bottom** of the doc (e.g. `## Plan — <label> (approved <date>)`). Guidelines todos start with only direction, so recording the plan you actually got approved means the doc carries the real, built plan when it eventually lands in `docs/done/`. Repeated passes **append** rather than overwrite, so a todo implemented in stages accumulates its full history. (A `full-plan` todo already carries its plan in the body — don't re-append; you reconcile it in step 8.)
- Build to the plan and the spec's **Done when**, respecting its **Out of scope**.
- **An issue surfaces mid-implementation? Tell the user, then see it solved.** AGENTS.md requires every finding to end up fixed or genuinely tracked toward a fix, never merely recorded, so never let one live only in chat.
  - **Related** — it sits on the same code path, or the todo's fix is incomplete or wrong without it. Fix it here; that is the ideal, a clean fix rather than a half one that spawns a follow-up.
  - **Unrelated** — delegate it to a parallel background agent via the [delegate-finding skill](../delegate-finding/): guidelines todo, stable commit, background session in this session's cloud environment, own branch and own PR — merged BEFORE this todo's PR. If this session was itself delegated (its prompt names a parent session), never delegate: file the finding as a guidelines todo with the create-todo skill, commit it in this PR and name it in the PR description.
  - **Genuinely cannot land now in either lane** (needs an upstream release, or a decision only the user can make)? File a `docs/todos/` spec with the evidence and a concrete fix plan, and tell the user it is still work owed rather than work closed out.
  - **Needs a decision you cannot make alone?** Manual: ask the user in this session and carry out the answer. Automatic: choose the safer, smaller option and record it for the final message.

## Step 8 — PR-readiness gate, then finish

Run the gate before calling it done:

- **Everything green** — `pnpm devx check` (format check, lint, typecheck, tests, build). Run `pnpm devx format` first; never hand-format.
- **Docs updated** per the plan.
- **Reconcile the spec with what shipped.** If the implementation diverged from the original todo — a different approach, a narrower or wider outcome, a decision the spec did not anticipate — edit the todo file so it describes what was **actually built** before it moves. A stale spec landing in `docs/done/` misleads the next reader.
- **Move the spec.** `git mv` it from `docs/todos/` into `docs/done/` and update it to match what shipped. This is a hard PR-readiness requirement, not an afterthought. If you deliberately shipped only PART of it, SPLIT rather than park: the moved doc records what landed and why the rest was cut, and the remainder becomes a NEW `docs/todos/` spec that reads on its own. There is no half-done lane.

## Step 9 — Review (always, with the review-pr skill)

Run the [review-pr skill](../review-pr/) over the branch, once the gate in step 8 is green. Tell it the mode from step 1, so it does not ask again: automatic fixes the findings itself, manual presents them and the user picks. This skill's comment pass comes after it, so the review does not run it and it runs only once.

When the review's fixes are committed, re-run the step 8 gate (`pnpm devx check`) before moving on.

## Step 10 — Comment simplification (always, by a subagent)

It runs after the review, so it sees the code the review fixes left. It is a subagent pass on purpose: this session knows why every comment exists and will defend it. A fresh context reads the code the way its next reader will.

1. List what the branch touched: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD -- '*.ts' '*.mjs' '*.js'`. Nothing listed means the step is a no-op; say so.
2. Spawn an independent `comments-simplifier` using the tool mapping, with those paths (or "the branch") and the instruction to read `.agents/skills/simplify-comments/SKILL.md` first. Do not run the skill yourself or explain why the text exists. Use the mapping's fresh-context fallback if the named role is unavailable.
3. Read its report. For every shortened or deleted comment, check the code: a fact the code cannot show (a reason, a constraint, an invariant, a trap) that the pass dropped goes back, in one line. Decide every **Kept** line yourself.
4. Re-run what the pass can break: `pnpm devx lint`. Run the skill's diff guard once more: nothing but comment lines may have changed.
5. Commit the pass on its own: `chore(comments): <area>`.

## Step 11 — Open the PR

The last step. Open it only once steps 9 and 10 are committed and the gate is green.

1. Check for a PR template (`.github/pull_request_template.md` and the other places the system prompt lists) and fill it in from the diff.
2. Create it with the available GitHub connector or `gh pr create`, base `main`, head the current branch. In Codex, attach the created PR with `codex_app.attach_artifact` when available.
3. Give the user the link, and say what shipped versus the todo's Done-when, flagging anything left for a follow-up.

## Step 12 — Drive CI to green

The PR is yours until it is green. Right after opening it, follow the PR monitoring instructions in the tool mapping, then follow the PR rules in the system prompt:

- A red check is work now. Reproduce it, fix it, run the repo's fast checks, push, and repeat until every check is green. Never skip or disable a test to get there.
- A merge conflict is also work now: rebase onto `origin/main` and push with `--force-with-lease`, never merge main in.
- Answer review comments the way step 9 sorts findings: fix, delegate, or reply with a reason.

Finish only when CI is green on the latest commit and there is no conflict. Then tell the user it is green, and in automatic mode list the decisions you made along the way. If only human approval is left, say so once.

## What NOT to do


- **Do not edit any file before the plan is approved.** Steps 1-6 are analysis only.
- **Do not skip tests on a fix or a feature** — the gate rejects it and so should you.
- **Do not add fuzzing without asking**, and do not hand-roll the fuzzer — route to the fuzzy-testing skill.
- **Do not pull candidates from `docs/done/`** — only `docs/todos/` holds ready work.
- **Do not exceed the todo's stated Out-of-scope**, and do not leave the spec sitting in `docs/todos/` after you finish it.
- **Do not skip the review, and do not open the PR before the review and the comment pass are committed.**
- **Do not stop at an open PR.** A red check or a conflict means the todo is not done.
- **Do not skip the comment pass, do not run it in this session, and do not accept a result that changed a fact.** Even a one-comment code change goes through the `comments-simplifier` subagent (the one exception is a branch that touched no source file), and its report is reviewed against the code, line by line, before it is committed.
- **Do not let an *unrelated* issue end as a filed-and-forgotten spec** — delegate it via the [delegate-finding skill](../delegate-finding/) (parallel agent, own PR, merged before this todo's PR); a spec is only for what truly cannot land in either lane, and it is a commitment to finish, not a way to close the loop.
- **Do not let a diverged spec move unchanged** — if what shipped differs from the plan, update the todo to reflect reality before `git mv`-ing it to `docs/done/`.
- **Do not reference a todo or done doc from any other file.** Not from docs, skills, workflows or code comments: those specs get deleted eventually. Write the reasoning where it is needed; if a spec lists documents that may go stale after merge, that list lives in the spec itself.
- **Do not answer the planning questions for the user** — steps 1 to 6 are interactive in both modes. Only after the plan is approved, and only in automatic mode, do you decide for yourself.

## Gotchas

- **Respect the question tool's option limit.** With more todos than that, list them all in prose and make the options a curated subset and the tool's free-text choice — otherwise the user cannot pick the ones you dropped.
- **A "full spec" still goes through the approval workflow.** Being already-planned by the author is not the same as approved by the user; present it anyway.
- **The plan gate protects you.** Entering plan mode after selection means investigation and questions cannot accidentally mutate files, and the user sees exactly what you intend before you build it.
- **Specs cite exact `file:line` locations** that drift as the code moves. Treat them as strong hints, but confirm the current location before editing.
- **A missing header is not a blocker.** Derive `type`/`spec` from the prose, backfill it after approval, and carry on. For a `guidelines` todo, **append** the approved plan at the bottom — never overwrite the original direction; the doc is meant to accumulate what got built so `docs/done/` shows the full history.
