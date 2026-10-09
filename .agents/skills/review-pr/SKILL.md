---
name: review-pr
description: Review vs repo rules in a fresh subagent, fix or user picks. Use when asked to review a PR, branch or diff.
---

# review-pr

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

Judge a change the way this repo does. Output: a findings report, never edits.

## Rules

- ⚠️ Review ALWAYS runs in a `pr-reviewer` subagent, never in the asking session. Even if caller did not write the code:
  a session reading this repo all day is not fresh either.
- Why: author's memory of why a line exists talks real findings out. Reviewer knows only what is on disk.
- Each checklist group gets its own agent: a group that cannot see another's work cannot talk its finding away.
- Checklist is never shown to the user for approval. Only findings are.
- ⚠️ Docs + comments are out of scope, completely. `comments-simplifier` agent owns comments, runs once after the
  review + its fixes (sees final text). Author owns docs. This skill runs neither.
- No item, no finding on a page, doc block or comment: not its wording, not its absence.
- "This feature has no docs" is NOT a finding: most tempting, deliberately not made
  (docs beside a change come out long + full of internals; repo prefers undocumented over over-documented).

Read your half:

- [Calling session](#calling-session): you were asked to review. 5 steps, none is reviewing. After step 1, runs alone.
- [Reviewer](#reviewer): you are a `pr-reviewer`: checklist builder, group checker or merger.

## Calling session

Never review: not before spawning, not "just the diff stat", no reading the diff to "check" a finding, no building
or editing the checklist (puts back the context the split removed).
Reading a finding's cited lines in triage is not reviewing: it is your job.
Step detail + prompts → [caller.md](caller.md).

1. **Ask the mode**: automatic or reviewed by you. Once, before anything else.
2. **Spawn the checklist reviewer**: one `pr-reviewer`, target + user worries only.
3. **Fan the groups out, one agent each**: every block verbatim, all in one message.
4. **Send the group reports to the merger**: SendMessage to the same checklist reviewer.
5. **Triage the report**: reviewed → user picks. Automatic → fix now / delegate / drop, then summary.

- Never show the checklist to the user or ask approval, either mode. Never drop a finding silently.

## Reviewer

You read, judge, report. Never edit, commit, run tests. Prompt names your role. Bias: **fewer committed lines**
(derivable new type, new file that fits in 3 lines of an existing one, one-caller abstraction = finding).

- Steps 1 to 4, checklist builder: **Scope**, **Frame**, **Build** the list, **Hand it back** by group.
  Detail → [checklist.md](checklist.md).
- Steps 5 + 6, group checker: **Check your group**, **Verify** every finding. Detail → [groups.md](groups.md).
- Step 7, merger (checklist builder resumed): **Merge and report** against the list. Detail → [merge.md](merge.md).

- Never wait for checklist approval. Hand it back and stop.
- Never check items as builder. As group checker never check another group's items.
- Never filter findings: each verified one gets its own entry. Summarising the list IS filtering it.
- Never run tests, builds or lint. Never report a test result you did not produce (host often not bootstrapped,
  "tests pass" from an unbuilt host is false). "No test for this behaviour" is fine + expected.
- Never report a rule you cannot quote: cite the line or call it taste.
- Never review untouched code. Next to the diff is not in it.
- Never rewrite a working approach that breaks no rule. "I would have done it differently" is not a finding.
- Never trust the spec or PR description as a description of the change. They are what is checked.
