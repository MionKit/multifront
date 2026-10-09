# run-milestone: finish the milestone

Orchestrator's steps 4 to 7, after every step's PR is merged.

## Step 4: QA, once for the whole milestone

All steps merged → spawn one `milestone-qa`:

```
Milestone: docs/milestones/<file>.md. Every step is merged on origin/main.
Branch: chore/m<N>-qa, cut from origin/main.
Follow .agents/skills/run-milestone/qa.md.
```

- Returns `QA <pr-url>` with one GitHub issue per finding, or `QA CLEAN <pr-url>`.
- Could not create issues → returns them as text. Create them yourself, as written.

## Step 5: One fixer for every finding

Spawn one `milestone-step` in fix mode, even when QA was clean (QA PR still must go green and merge):

```
Fix mode. Milestone: docs/milestones/<file>.md.
QA PR: <url> on branch chore/m<N>-qa. Issues: #<a>, #<b>, ...
Follow .agents/skills/run-milestone/step.md, "Fix mode".
```

Answer it exactly as in SKILL.md step 2, then watch + merge its PR as in step 3.

## Step 6: Public docs, once for the whole milestone

Fixer's PR merged → milestone is checked, now write about it. Spawn one `public-docs-writer`:

```
Milestone: docs/milestones/<file>.md, merged and checked on origin/main.
Branch: docs/m<N>-public-docs, cut from origin/main.
Follow .agents/skills/run-milestone/docs.md.
```

- Returns `PR <url>`, or `QUESTION` when code + tests cannot tell what a user sees.
  Answer by [decision rules](answers.md#decision-rules).
- Watch + merge its PR as in SKILL.md step 3. Red CI goes back to it.
- Changes no source file → no review, no comment pass.

## Step 7: Close the milestone

Fetch `origin/main`. Check: every step has `- Status: done`, `## Manual QA` section is there,
every QA issue closed, public docs PR merged. Then tell user, short:

- merged PRs, one link each;
- every decision you made answering a `QUESTION`, one line each
  (each also lives in its step's todo, now in `docs/done/`);
- todos filed for unrelated findings (SKILL.md, "Findings off the step's path"), manual QA checks left for a person.
