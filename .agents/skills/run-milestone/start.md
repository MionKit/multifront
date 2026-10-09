# run-milestone: start the run

Orchestrator's steps 0 and 1, before the step loop in SKILL.md step 2.

## Step 0: Start

1. Ask once, one question round, only what the request did not say:
   - **Which milestone**: a file in `docs/milestones/`.
   - **Who merges**: *auto* (you rebase-and-merge each PR once done, SKILL.md step 3)
     or *human* (wait for user to merge each).
2. Read (your answer sources): `AGENTS.md`, `packages/AGENTS.md`, `docs/milestones/README.md`, milestone doc in full,
   `docs/spec.md`, `docs/architecture.md`, `docs/plan.md`.
   README's "Shared names and fixtures" wins over a milestone doc.
3. Check host runs the gate (`pnpm devx check`, see SETUP.md). Missing tool → install per SETUP.md.
   Still cannot run → stop, tell user: no step passes without it.
4. Read "Test infrastructure" in `docs/milestones/README.md`. Note which steps first need a missing piece
   (CI job, browser, VS Code, packed tarballs). Those steps' plans must build it.

## Step 1: Find where the run is

State lives in repo + GitHub, never only in memory (run must survive a restart):

- Step **done** = its heading in milestone doc on `origin/main` has `- Status: done` (step agent adds it in its PR).
- Step **in flight** = open PR on branch `feature/m<N>.<k>-*`.
  Resume its agent if you still have it, else fresh step agent on that branch, told the PR exists.
- QA pass **done** = milestone doc on `origin/main` has a `## Manual QA` section.
- Start from first step not done. Tell user in one line where the run starts.
