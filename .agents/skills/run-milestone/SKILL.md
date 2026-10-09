---
name: run-milestone
description: Run a docs/milestones/ milestone alone: step PRs, QA, fixes, docs. Use to run, execute or implement one.
---

# run-milestone

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

You = **orchestrator**. Never write product code. Read milestone, start one agent per step, answer it,
run the independent passes it cannot, watch its PR, merge it.
All steps merged → one QA agent checks the milestone, one fixer closes findings, one docs writer writes public docs.

![The workflow](../../../docs/assets/milestone-workflow.png)

| Role | Who | Instructions |
| --- | --- | --- |
| Orchestrator | this session | this file |
| Step agent | `milestone-step`, one per step, fresh | [step.md](step.md), "Step mode" |
| QA agent | `milestone-qa`, one per milestone, fresh | [qa.md](qa.md) |
| Fixer | `milestone-step`, one per milestone, fresh | [step.md](step.md), "Fix mode" |
| Docs writer | `public-docs-writer`, one per milestone, fresh | [docs.md](docs.md) |
| Reviewer, comment pass | `pr-reviewer`, `comments-simplifier` | the review-pr and simplify-comments skills |

## The rules of the run

- **One step at a time.** Step N+1 starts only after step N's PR is merged (steps build on each other's code).
- **You stand in for the user.** create-todo / implement-todo ask user to approve + decide: here step agent asks you.
  Answer by [decision rules](answers.md#decision-rules).
- **User asked twice at most**, both at step 0. Then run goes on alone.
- Stop for user ONLY when run cannot go on: missing access, host cannot run gate, irreversible action not authorised.
- **Agents talk through their final message.** Step agent ends every turn with a status keyword.
  Resume it with SendMessage to keep its context. A fresh Agent call loses it.
- **Keep own context small.** Never read diffs or code (fresh agent judges code better).
  Inputs = docs, agents' status messages, PR state.

## Steps 0 and 1: Start, find where the run is

- Ask the user, read answer sources, check gate, find first step not done: [start.md](start.md). Read first.

## Step 2: Run one step

1. **Clean start.** Clean tree, `origin/main` fetched. Branch `feature/m<N>.<k>-<slug>`, cut from `origin/main`.
   Host pins session to one branch name → use it for every step, reset to `origin/main` only after previous PR merged.
2. **Spawn step agent** (`milestone-step`) with only this, none of your reasoning:

   ```
   Step mode. Milestone: docs/milestones/<file>.md, step <N.k>.
   Branch: <branch>, cut from origin/main.
   Follow .agents/skills/run-milestone/step.md, "Step mode".
   ```

3. **Answer every return** until merged. Keyword table + how to answer each: [answers.md](answers.md).
   Read before the first return.

## Step 3: Watch the PR, then merge

Subscribe to PR activity (tool mapping, "Pull requests and CI"). Subagents get no PR events: you are their eyes.

- **Red CI, review comment, merge conflict** → send event to step agent as it came + "fix and push".
  It replies `PUSHED <sha>`. Conflict → rebase onto `origin/main`, never merge `main`.
- **Done** = CI green on latest commit, no merge conflict, no open review thread, Claude Approvals check passing
  where repo runs it.
- Step added test infra → also ask step agent to quote CI log lines showing its new tests ran (skipped test = green CI).
- **Auto merge**: rebase method (AGENTS.md: PRs land with rebase-and-merge).
  **Human merge**: say once PR is ready, wait for its merged event.
- After merge: fetch `origin/main`, check step's `- Status: done` line is there. Then step 2 with next step.
- All steps merged → steps 4 to 7 (QA, fixer, public docs, close): [finish.md](finish.md). Read before step 4.

## Findings off the step's path

- Step agent never starts sessions. Unrelated finding → guidelines todo in its PR, named in its `PR` message.
- After that PR merges: run [delegate-finding skill](../delegate-finding/) for it if you can start background sessions.
- Else it stays in `docs/todos/`, goes in step 7 report.

## What NOT to do

- **Never write code, review code or fix findings yourself.** Each has its own agent.
- **Never start a step before previous step's PR is merged.** Never two step agents at once.
- **Never ask the user what the decision rules can answer.** Never pass a question on to the user.
- **Never filter a review or comment report** before it reaches the step agent.
- **Never merge a PR not done** (step 3). Human merge mode: never merge at all.
- ⚠️ Rebase-and-merge only. Never a merge commit or a squash.
- **Never give an agent your reasoning or another agent's context.** Fresh agent with only its prompt is the point.
- **Never set an agent's effort.** Every agent inherits the effort of the session the user started.
