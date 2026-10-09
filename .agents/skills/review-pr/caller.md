# Calling session: steps 1 to 5

Detail for the session that asked for the review. Rules + arc: [SKILL.md](SKILL.md#calling-session).

## 1. Ask the mode

Ask once with the question tool, before anything else:

- **Automatic**: whole review runs, you decide what to fix and fix it, no more questions. User gets a final summary.
- **Reviewed by you**: whole review runs, you present every finding, user picks what to fix.
- Mode already in the request ("review it and fix what matters") or passed by the calling skill → skip the question.

## 2. Spawn the checklist reviewer

One independent `pr-reviewer` via the tool mapping, target only:

```
Review <the current branch against origin/main | branch <name> | PR #<n>>.
Follow the review-pr skill, the reviewer's half, from step 1.
No approval is coming: return the final checklist, one block per group.
```

- Add what the user said worries them, in their words.
- Never add your own summary of the change: reviewer reads disk, your summary is the context the split keeps out.
- Role unavailable → fresh-context fallback from the tool mapping, told to read this skill first.

## 3. Fan the groups out, one agent each

- Builder's first turn ends with the final checklist: pinned merge-base, intent, one block per group.
- One `pr-reviewer` per group (user request fitting no group = group `U`), all in ONE message so they run at once.
- Copy each block verbatim (copying is not editing). Never trim it. Never two groups to one agent.
- Nothing else goes in: no change summary, no other group's items.

```
Check group <X> of the checklist for <the target>.
Follow the review-pr skill, the reviewer's half, role "Group checker".
Merge base: <sha>
Intent: <the intent paragraph, verbatim>
Items:
<the group's block, verbatim>
```

Each returns its answers + verified findings. Relay nothing yet.

## 4. Send the group reports to the merger

- SendMessage every group report, whole + unedited, to the checklist reviewer (fresh Agent call loses context).
- Never start a new reviewer for the merge. Group agents are the only other reviewers.
- It merges cross-group duplicates into one report: it built the list and knows the change, group agents do not.

```
Group reports follow. Merge them into the report, step 7.
<every report, one after another>
```

## 5. Triage the report

- Report = every finding that survived verification. Never summarise or cut it first: hidden = lost.
- **Reviewed by you**: present EVERY finding, reviewer's order, then ask what to fix. Filter fixes, never findings.
  Never recommend dropping one: recommending is fine, dropping is the user's call. Fix only after the user picks.
- **Automatic**: read the code at each cited line, then sort each finding:
  - **Fix now**: right + related. Fix in this PR, own commit, own test.
  - **Delegate**: right but unrelated → parallel background agent via [delegate-finding](../delegate-finding/).
    Never a backlog note.
  - **Drop**: wrong, already fixed, or pure taste. One line why each.
  - Nits: read each for what it says, not its label (the label is the reviewer's guess). Nits have held real bugs
    (wrong name, missing case, small rule break). Drop one only when you can say why it is wrong or both readings
    are fine. Unsure → fix.
- Automatic done → short summary: fixed, delegated, each drop + reason.
- User wants findings on GitHub → inline review comments. Resolve a thread only once actually fixed.
