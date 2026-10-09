# implement-todo: build and ship (steps 7 to 12)

Starts only after step 6 approval.

## Step 7: Implement

- Branch check first: work lands on a feature branch, never `main` (Git workflow in [AGENTS.md](../../../AGENTS.md)).
  On `main` → create a branch before editing.
- Record the plan in the todo doc before building:
  - Step 2 found no frontmatter → write the derived `type` / `spec` / `status` / `created` block at the top now,
    so the doc is normalized for the next run and the `docs/done/` archive.
  - `guidelines` todo → append the approved plan as a new section at the **bottom**
    (e.g. `## Plan: <label> (approved <date>)`). The doc then carries the real, built plan into `docs/done/`.
  - Repeated passes append, never overwrite the original direction: a staged todo accumulates its full history.
  - `full-plan` todo already carries its plan in the body: no re-append, reconcile it in step 8.
- Build to the plan + the spec's **Done when**, respecting its **Out of scope**.

### Issue found mid-implementation

Tell the user, then see it solved. AGENTS.md: every finding ends fixed or genuinely tracked toward a fix.
Never merely recorded, never living only in chat.

- **Related** (same code path, or the todo's fix is incomplete or wrong without it) → fix it here.
  The ideal: a clean fix, not a half one that spawns a follow-up.
- **Unrelated** → parallel background agent via the [delegate-finding skill](../delegate-finding/): guidelines todo,
  stable commit, background session in this session's cloud environment, own branch + own PR.
  Merged BEFORE this todo's PR.
- Unrelated, but this session was itself delegated (its prompt names a parent session) → never delegate.
  File the finding as a guidelines todo (create-todo skill), commit it in this PR, name it in the PR description.
- Genuinely cannot land now in either lane (needs an upstream release, or a decision only the user can make)
  → file a `docs/todos/` spec with the evidence + a concrete fix plan. Tell the user it is work still owed, not closed.
- Needs a decision you cannot make alone → manual: ask in this session, carry out the answer.
  Automatic: choose the safer, smaller option, record it for the final message.

## Step 8: PR-readiness gate, then finish

- Everything green: `pnpm devx check` (format check, lint, typecheck, tests, build).
  Run `pnpm devx format` first; never hand-format.
- New tests ran: in gate output, and later the CI log, every test this todo added executed.
  None skipped, none filtered out for want of a browser or a binary.
- Docs updated per the plan.
- Reconcile the spec: implementation diverged (other approach, narrower or wider outcome, unanticipated decision)
  → edit the todo to describe what was **actually built** before it moves. A stale spec in `docs/done/` misleads.
- Move the spec: `git mv` from `docs/todos/` into `docs/done/`, updated to match what shipped.
  Hard PR-readiness requirement, not an afterthought.
- Shipped only PART on purpose → SPLIT, never park: moved doc records what landed + why the rest was cut.
  Remainder = NEW `docs/todos/` spec that reads on its own. No half-done lane.

## Step 9: Review (always, review-pr skill)

- Once step 8 is green, run the [review-pr skill](../review-pr/) over the branch.
- Pass it the step 1 mode so it does not ask: automatic = it fixes findings itself, manual = presents them, user picks.
- Review does not run the comment pass: step 10 does, so it runs once.
- Review fixes committed → re-run the step 8 gate (`pnpm devx check`) before moving on.

## Step 10: Comment simplification (always, by a subagent)

Runs after the review: sees the code the review fixes left. Subagent on purpose: this session knows why every comment
exists and will defend it. A fresh context reads the code like its next reader.

1. List touched files: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD -- '*.ts' '*.mjs' '*.js'`.
   Nothing listed → step is a no-op; say so.
2. Spawn an independent `comments-simplifier` (tool mapping) with those paths (or "the branch")
   + the instruction to read `.agents/skills/simplify-comments/SKILL.md` first.
   Never run the skill yourself or explain why the text exists. Role unavailable → mapping's fresh-context fallback.
3. Read its report. Per shortened or deleted comment, check the code: a dropped fact the code cannot show
   (reason, constraint, invariant, trap) goes back, in one line. Decide every **Kept** line yourself.
4. Re-run what the pass can break: `pnpm devx lint`. Run the skill's diff guard again: only comment lines may change.
5. Commit the pass on its own: `chore(comments): <area>`.

## Step 11: Open the PR

Last step. Only once steps 9 + 10 are committed and the gate is green.

1. Check for a PR template (`.github/pull_request_template.md` + other places the system prompt lists).
   Fill it in from the diff.
2. Create with the GitHub connector or `gh pr create`, base `main`, head the current branch.
   Codex: attach the created PR with `codex_app.attach_artifact` when available.
3. Give the user the link. Say what shipped vs the todo's Done-when; flag anything left for a follow-up.

## Step 12: Drive CI to green

PR is yours until green. Right after opening: PR monitoring per the tool mapping, then the system prompt's PR rules.

- Red check = work now. Reproduce, fix, run the fast checks, push, repeat until every check is green.
  Never skip or disable a test to get there.
- Merge conflict = work now: rebase onto `origin/main`, push with `--force-with-lease`. Never merge main in.
- Review comments: sort like step 9 findings: fix, delegate, or reply with a reason.
- Finish only when CI is green on the latest commit + no conflict. Tell the user it is green.
- Automatic → list the decisions you made. Only human approval left → say so once.
