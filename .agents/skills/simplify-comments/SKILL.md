---
name: simplify-comments
description: Cut comments to what code can't say, no fact lost. Use before a PR on touched code or to clean up comments.
---

# simplify-comments

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

Read every comment the branch added or changed, and every comment in a function it touched.
Leave only what the code cannot say.
Correctness first: a wrong comment, or one that lost its one fact, is worse than a long one. Simplify second.
Output: files edited in place + report of every comment changed, deleted or kept as is, with the reason.

## The rules

Read the *Code style* section of the root [AGENTS.md](../../../AGENTS.md) first, every run.

1. **One line, under about 120 characters.** Not a paragraph squeezed onto it: past ~120, cut words, or split into
   two lines of one sentence each. A `/** */` or `/* */` one-liner counts. Only multi-line comment allowed: top of a
   file, one paragraph max, only when the file needs a reason to exist that its name and exports do not give.
2. **Only what the code cannot say.** A reason, constraint, invariant, ordering requirement, trap, or link to the thing
   that forced the choice. What the code below shows goes (what it does, which function it calls, what the branch
   checks, what the variable holds).
3. **Correct over short.** Shortening would drop the fact → keep the fact, cut words around it. Unsure what it means →
   read the code until sure; still unsure → leave it, list it in the report.
4. **Always shorter, usually much shorter.** Every comment you touch ends with fewer words, most with far fewer: five
   lines to one is normal, not the exception. Comes out longer = failed edit: revert, list under Kept with why.

## Scope

Given a list of paths or "the branch". For the branch:

```bash
MB=$(git merge-base origin/main HEAD)
git diff --name-only $MB..HEAD -- '*.ts' '*.mjs' '*.js'
git diff $MB..HEAD -- <each file>          # which comments and which functions changed
```

- Yours: every comment the branch added or changed + every comment inside a function or block the branch changed.
- Not yours: comments in code the branch did not touch, however bad.
- Never touch: semantic comments + directives (below), plus `// biome-`, `// ^?`, `// ^|`, `// @annotate`,
  `// start-` / `// end-` markers, and any other comment a tool reads.
- Never touch: license headers; generated files (`*.generated.*`), test fixtures, `node_modules/`.
- Never touch anything not a comment. Code, strings, test names and JSON tags stay byte for byte.

## Semantic comments are protected

They control builds, diagnostics, generated output or tests. These rules override the one-line + word-count rules.

- Keep the entire comment byte for byte: tag, arguments, diagnostic names, surrounding text.
- Never delete, shorten, reflow, split, combine or move it, or change its comment delimiters.
- Keep its attachment: line directives target the same next statement; declaration tags stay on the same declaration.
- Also preserve: TypeScript `@ts-*` directives; JSDoc tags + blocks consumed by typechecking, esp. in JS/MJS/CJS;
  `@vite-ignore`; `@vitest-environment` + its options; webpack magic comments; `__PURE__`; `__NO_SIDE_EFFECTS__`;
  coverage, formatter + lint directives (`istanbul`, `c8 ignore`, `v8 ignore`, `prettier-ignore`, `oxfmt-ignore`,
  `eslint-*`, `oxlint-*`); triple-slash references; source-map directives; shebangs.
- A package name in ordinary prose is not a semantic tag. Prose mixed with a semantic tag → keep whole comment as is.
- Unfamiliar marker → keep it, report why.

## Per comment

In this order, for each comment you own:

0. **Semantic tag or another tool reader?** Protected → straight to Kept. Skip the shortening steps.
1. **Read the code it sits on** until you can say in one sentence what the code does without the comment.
2. **Find the fact the code cannot say.** Cross out every clause the code already shows. Rest = the comment.
   Nothing left → delete it.
3. **Write it as one line**: plain words, fact first, under about 120 characters.
4. **Check it against the code again.** New line must be true of the code as it is now, not as the old comment said.
5. **Multi-line file header** → one paragraph: why the file exists + the one thing a reader must know before
   editing it. Delete the rest, or move a line that belongs to a specific function onto that function.

## Verify and report

- Guard, protected-comment check, word counts + report shape → [verify.md](verify.md). Run before handing back.

## What NOT to do

- **Do not change code.** Not a name, not a blank line inside a function, not an import order.
  The guard in [verify.md](verify.md) catches it; do not work around the guard.
- **Do not delete a fact.** A reason, a constraint, an invariant, a trap: it stays, in fewer words.
- **Do not guess.** A comment you do not understand is kept and reported, never "simplified".
- **Do not touch a directive or a generated file.**
- **Do not add comments.** Even where one seems missing. Say so under Kept.
- **Do not commit.** The caller reviews the report against the code and commits.

## Gotchas

- **Run in a fresh context.** The session that wrote the code knows why every comment is there and keeps them all.
  You are that session → hand this to the `comments-simplifier` agent.
- **"Why" often hides at the end of a long comment.** Read to the last sentence before deciding it restates the code.
- **A comment naming a file or function is often the only link.** "Mirrors X in file Y" is a fact the code cannot
  say; keep the pointer, cut the prose around it.
