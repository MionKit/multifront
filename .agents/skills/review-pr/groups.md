# Group checker: steps 5 and 6

One group per agent. Read Step 5, Step 6, then your group's section.

- You get one group: items, merge-base, intent. You did not build the list, cannot see other groups: the point.
- A group never restates a repo rule. Items say what to check, repo items name their file (copied rules go stale).
- No docs group, no comments group: see the scope rule in [SKILL.md](SKILL.md#rules).

## Step 5 - Check your group

- Diff range, exactly this, nothing else: `git diff <MERGE_BASE>..HEAD`. Large change → area by area.
- Read the diff + the spec if one is in it, then your group's section below.
- User group `U`: no section. Judge its items vs the diff with these general rules.
- Check your items in order, nothing else. Another group's item is another agent's job.
- Answer EVERY item: pass, fail, or not applicable. Skipped to come back to = goes missing.
- Item tagged `[repo: <file>]`: open that file, read current wording before judging, quote it.
  Checklist paraphrase is a pointer, not the rule.
- Cite only lines in this diff. Quote a rule only if read in a real file, naming it.
- Record each answer as you go:

```
- id:     A5
  result: pass | fail | not-applicable
  where:  path/to/file.ts:LINE        (for a fail, and for a pass you had to work for)
  evidence: the exact line(s) from the diff
  reason: the quoted rule, or why it costs the reader
  fix:    the concrete smaller change, with the replacement text where short
  severity: blocking | worth-fixing | nit
  confidence: high | medium | low
```

- Serious problem no item covers → **off-list**, same shape. Real problems only, not "I would write it differently".
- Passed everything in a few lines = skimmed. One group, fresh context, no excuse: go back and read.

## Step 6 - Verify before you report

Nothing reaches the report unverified, your own findings from an hour ago included:

- **Citation real**: open file at cited line, code says what the finding claims.
- **Rule real**: repo-rule finding quotes the line it breaks, you confirm it exists. Else drop or relabel as taste.
- **Simpler option really simpler**: removes more lines than it adds, keeps behaviour. Cannot show it → drop.
- **In scope**: change = the diff. Problem in untouched code → off-list, say so.
- **Count what survived**: list + count every verified finding. Count per FINDING, never per item:
  an item with two findings reads as one by the report, the second goes missing.

End turn with every item's answer, in the shape above, then the count. That is your whole report.

## Group S: spec and description

- Re-read spec + PR description vs the diff, not vs themselves. Both written before the code.
- Check shipped vs spec's `Done when`, item by item: a `Done when` line nothing satisfies = finding.
- Listed in `Out of scope` but shipped = finding.
- Partial ship: spec must say so, rest becomes a new `docs/todos/` spec, never a half-done note.
- Spec still in `docs/todos/` after its work shipped = fail. Description claiming what the diff does not do = fail.

## Group G: repo guidelines

- Items come from AGENTS.md files governing changed paths: dependency shape, env vars, file placement,
  build steps, commit + branch shape, anything with no other group.
- Read each named AGENTS.md in full before its items (short). Pointer to another doc for an area this diff
  touches → read that too.
- Judge vs wording read, not item paraphrase. Rule narrower than item → pass with a note.
  Wider + diff breaks wider version → fail with real quote.

## Group T: types and reuse

- List every type, interface, enum, exported function the diff ADDS. Check items vs that list.
- Search before judging: grep same package, then siblings, then shared packages for same field set, shape,
  or job under another name.
- Reuse claim needs the existing declaration by file + line, plus the derived form
  (Pick, Omit, Partial, Extract, ReturnType, generic parameter, extending it). No existing one → no finding.
- Import would cross a package boundary the repo forbids? Package AGENTS.md states boundaries: read it, never assume.
  Deliberate duplication across such a boundary is correct.

## Group A: architecture and size

- Work from diff stat + added files the scope script printed: size is a number, not an impression.
- Restate intent in one sentence, describe smallest change achieving it, compare to diff, then check items.
- Every fail carries a number: ~committed lines the simpler shape removes + behaviour unchanged.
- Simpler shape only different (not smaller, not clearer) → pass, move on.
- New file: low bar to question it. Cost of putting the code in the file that already owns the job? Often nothing.
- Placement: read the involved packages' AGENTS.md, judge vs what they state, not what looks tidy.
- Never propose refactoring code the diff does not touch.

## Group B: behaviour and tests

- Read changed code enough to say what it does now vs before, then check items.
- Behaviour fail needs the input or state reaching it: "empty array reaches line 42 and it indexes [0]".
  Worry with no path = not a finding.
- Coverage item: name the missing test + what it pins. Check no existing test covers it first.
- Check whether any test was weakened, skipped or deleted in this diff.
- Run nothing. Read tests, never execute: a result you did not produce = false claim.
