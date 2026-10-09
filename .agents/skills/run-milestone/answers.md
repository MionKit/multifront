# run-milestone: answering a step agent

Orchestrator's guide to step 2's returns, and to every `QUESTION`, `BLOCKED`, `AMEND`.

## Keywords

First line of each return = one keyword:

| Keyword | Means | You do |
| --- | --- | --- |
| `PLAN` | drafted full-plan todo, ready for approval | check it (below), reply `APPROVED` or `AMEND: <changes>` |
| `QUESTION` | fork the docs did not settle | reply a decision (decision rules) |
| `BLOCKED` | it cannot go on | remove blocker, or decide around it |
| `REVIEW` | gate green, needs the review | run the review (below), send whole report |
| `COMMENTS <files>` | needs the comment pass | run the comment pass (below), send whole report |
| `PR <url>` | PR is open | watch it (SKILL.md step 3) |
| `PUSHED <sha>` | pushed a fix you asked for | keep watching |

## Checking a PLAN

Compare with the step's Build, Deliverable and Test lines, line by line. Each item missing → `AMEND`:

- Every name and shape exact.
- Every test follows the testing rules (real files, real tools, no mocks).
- Step's Out of scope and milestone's respected.
- Plan names the docs it changes.
- Every test says where it runs.
- Test needing infra CI or host lacks → comes with plan to build it (README's "Test infrastructure").
- Plan adds work the step does not ask for → `AMEND` too.

## Running the review

- Step agent cannot always start agents → you run calling half of review-pr skill for it, steps 2 to 4:
  spawn `pr-reviewer` on step's branch, fan groups out, get merged report.
- Never triage it: send it whole. Step agent triages + fixes in automatic mode.
- Step agent can start agents → it runs the review alone, never sends `REVIEW`.

## Running the comment pass

- Spawn a `comments-simplifier` with file list + instruction to read `.agents/skills/simplify-comments/SKILL.md` first.
- Send its report whole to step agent. It checks report against code + commits it.

## Decision rules

Every `QUESTION`, `BLOCKED`, `AMEND` → first rule that settles it. Quote the line that settled it.

1. **The docs.** Milestone doc, then `docs/milestones/README.md` (wins over milestone doc), `docs/spec.md`,
   `docs/architecture.md`, `docs/plan.md`, AGENTS.md, `packages/AGENTS.md`.
2. **Do what Vue does.** multifront builds one component for several frameworks, all must behave the Vue way.
   Docs silent → copy what Vue, plugin-vue or `@vue/compiler-sfc` do, and name where.
3. **Make the developer's life easier.** Clearer error, less config, fewer surprises for multifront users.
   Unless it adds work the step does not ask for: scope creep loses.
4. **Still a tie**: smaller change, easier to undo.

Every answer carries:

- Decision, rule + line that settled it, doc that changes because of it (step agent edits it in same PR).
- Decision changes a name/shape in milestone's "Hands to later milestones" table → step agent also updates
  every later milestone doc using it.
