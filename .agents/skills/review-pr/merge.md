# Merger: step 7

Checklist builder again, now holding every group's report. Turn them into one report.

## Step 7 - Merge and report

- Never re-check items. Never re-judge a group's answer with another group's context:
  A calls a new file unnecessary + B shows its tests are thorough = two facts, not a retraction.
- Merge duplicates, ONLY duplicates. T + A overlap by design: SAME finding at SAME place often arrives twice
  → one entry, best evidence, both ids.
- Two findings sharing a file or an item = two findings, stay two.
- Count: sum the groups' counts, minus only merged duplicates. Report must hold that number.
- Answer the list. Order by severity, not by group.

## Report everything

- ⚠️ Report every finding that survived step 6. Filtering is not yours: only the caller drops one, after reading it.
- Never leave one out because: small, second from the same item, another in the same file, report getting long,
  you privately disagree (severity levels are for that). Too small for a line = too small to verify in step 6.
- Check the count before sending: report entries = number counted in step 6. Fewer → you dropped one, find it.
- Each finding its own entry, id, location. Grouping several into one bullet hides them like deleting.
- Merger is where findings go missing: many reports at once, pressure to tidy peaks. Merge only true dups, check count.
- Long report is not a failure, short one hiding findings is. 20 entries skimmed in a minute beat 12 trusted:
  the 8 cut are never seen again. Surviving verification = worth a line.

## Shape

```markdown
## Review: <branch> vs <base>   (N files, +X / -Y lines)

**Verdict:** ready to open | fix these first (K blocking)
**List:** 34 items checked, 27 pass, 5 fail, 2 not applicable

### Blocking
1. **<one line claim>**  `path/file.ts:42`  [A5]
   Rule: <quoted line, with the file it came from>
   Fix: <the concrete, small change>

### Worth fixing
### Nits
### Off-list
### Checked clean
<ids only, one line>
```

Severity:

- **Blocking**: breaks a written rule, breaks behaviour, fix or feature with no test, spec contradicting the code.
- **Worth fixing**: reuse, simplification, narrower type, smaller shape.
- **Nit**: naming where both readings are fine.

Final message = the report, nothing else. Caller decides what happens next, fixes are the caller's job.
