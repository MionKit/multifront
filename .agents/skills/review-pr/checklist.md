# Checklist builder: steps 1 to 4

Reviewer's half, first role. Build one filtered, grouped list. No approval step.

- Why a list first: a review with no written scope reads as opinion, nobody can tell what it skipped.
  Written list = auditable, every finding gets a number to point at.
- The checklist is the first half's deliverable. Vague item ("check the types are sensible") → vague check.
  Each item checkable against a line of the diff.

## Step 1 - Scope

```bash
bash .agents/skills/review-pr/scope.sh [base-ref]
```

- Prints: base ref, merge-base sha, commits, diff stat, biggest added files, renames, AGENTS.md governing each
  changed path, spec docs in the diff, source areas changed with no test change.
- ⚠️ Pin the merge-base sha it prints. Every group diffs `<merge-base>..HEAD`: one identical change set.
- `origin/main..HEAD` is not the change: a moving `origin/main` makes upstream commits look like the author's work.
- Target:
  - Nothing named: current branch vs `origin/main`.
  - Branch named: check it out or diff it, base still `origin/main`.
  - PR number: GitHub connector or `gh pr view` for description, base branch, open review threads.
    Fetch head branch, diff locally vs that PR's own base.
- Read the whole diff: `git diff <merge-base>..HEAD`. Large change → area by area.
  No real list or verified finding about a change you have not seen.

## Step 2 - Frame: the spec and the description

- Both written before the code, often never updated. Claims to test, not context to trust.
- A spec that reads perfectly can still be stale. Check it vs the diff, not vs itself.
- Spec: file renamed `docs/todos/` → `docs/done/` in the diff. No rename → spec still in `docs/todos/`, or none.
  Read it whole: metadata header, `Done when`, `Out of scope`.
- Read the PR description, when there is a PR.
- Write the **intent**: one short paragraph, what the change is meant to do. Heads checklist + report
  (reviewer who loses the goal reports noise).
- Do not judge the spec yet: it becomes items `S1` to `S4`, checked in step 5.

## Step 3 - Build the review list

- Built fresh every review from files on disk. Nothing carried over from a past review or memory.
- AGENTS.md files ARE the guidelines. Read every one the script named, in full, every review.
  Most specific last: it wins on conflict. They evolve: a remembered rule is a wrong rule.
- One points at another doc for an area this diff touches → read that too.
- Items: rules that could apply to these files, one line each, quoted or close paraphrase, source file named.
- Drop rules for areas the diff does not touch. Say which areas dropped.
- Show count per file:

```
AGENTS.md                        14 rules apply
packages/vite/AGENTS.md           4 rules apply   (if that package has one)
```

- Then top up from [global-checks.md](global-checks.md): add groups whose trigger the diff meets.
- Never build the list from the catalog alone.
- Never run a whole group the diff does not trigger: items that cannot apply hide the ones that can.
- Catalog item + repo rule say the same → keep repo rule (quotable, current), drop catalog item.
- Never copy AGENTS.md rules into this skill. Read per review, quote from the file, cite by file name.
- Repo rule about docs or comments → no item at all, whatever it says.
- Merge both into one list, grouped:
  - S: spec and description
  - G: repo rules with no other home (dependencies, env vars, commit + branch shape, build steps)
  - T: types and reuse
  - A: architecture and size
  - B: behaviour and tests
- Number items inside each group, tag the source, so a finding points at one line:

```
G2  [repo: AGENTS.md]                         Every new env var is registered and MULTIFRONT_ prefixed
T1  [global]                                  MethodIdCheck is not derivable from an existing type
B6  [global]                                  Every changed behaviour has a test that would fail without it
```

## Step 4 - Hand the checklist back

- End turn with the **final checklist**: pinned merge-base, intent, per-file rule counts,
  dropped groups + why ("no T group, the diff adds no types"), one block per group (only its items, ids, sources).
- Caller's prompt names user worries → items in the user's words, in the fitting group or own group `U`.
- Nobody approves it. Caller copies each block to its own group checker.
- Never check items yourself. Steps 1 to 3 = reading + listing. Step 4 = full stop. Next job: step 7.
