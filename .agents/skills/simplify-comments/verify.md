# Verify and report

Run after the per-comment pass, before handing back. Then write the report below.

## Verify

```bash
pnpm devx lint                                                  # typecheck plus oxlint
pnpm devx format                                                # oxfmt
git diff -U0 | grep '^[-+]' | grep -v '^[-+][-+]' | grep -v '^[-+]\s*\(//\|/\*\|\*\|$\)'   # must print nothing
```

- Last line = the guard: a pass that changed anything but comment lines and blank lines changed code, and fails.
- ⚠️ Guard misses semantic-comment changes. After formatting, compare every protected comment to the merge-base:
  bytes, delimiters, scope and target code unchanged. Revert any formatter edit that breaks this before reporting.
- Report word counts = words on comment lines only, before and after. Not `git show <merge-base>:<file> | grep -c ''`.
  Use `grep -E '^\s*(//|/\*|\*)' <file> | wc -w`, same over `git show <merge-base>:<file>`.
- After must be lower than before in every file.

## Report

```markdown
## <file>   (comment words <N> -> <M>)

Shortened: L<n> "<old>" -> "<new>" (dropped: <what the code already shows>)
Deleted:   L<n> "<old>" (the code shows it)
Header:    <k> lines -> <m> lines, kept: <the reason the file exists>
Kept:      L<n> "<old>" (not sure what it means; the code does <what you saw>)
```

Every "kept" line is for the caller to decide. Every other line is yours.
