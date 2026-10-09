# implement-todo: plan (steps 1 to 6)

Analysis only. No file edits before step 6 approval.

## Step 1: Pick the todo and the mode

- Source: `docs/todos/*.md` ONLY. Sibling dirs are not candidates: `docs/done/` is finished. Ignore `.gitkeep`.
- User already named one (filename, path under `docs/todos/`, unambiguous description like "the union guard dedup one")
  → skip the question, confirm which file you landed on, go to step 2.
- Ask the mode (automatic / manual) in the same question round, or its own round if the user named the todo.
- Else ask with the question tool. Respect its option limit (often fewer than the todos):
  - First list EVERY todo in prose, one line each: filename, one-line gist, status if the file states one (`READY`).
  - Options = curated set (prefer `READY` / next-release) + free-text for the rest. Else user cannot pick dropped ones.

## Step 2: Read it fully, then summarize

- Read the metadata header first. Todos from `create-todo` open with YAML frontmatter:
  `type` (`fix` | `feature` | `docs` | `chore`) + `spec` (`full-plan` | `guidelines`). These two drive everything after.
- Header optional (older or hand-filed todos). Missing is not a blocker: derive `type` + `spec` from the prose
  (Status line, shape), plus `status` / `created`. Write it back in step 7 (after approval) so the next run reads it.
- Read the whole file. Follow enough `file:line` pointers to understand the change (specs cite exact functions).
- Short summary to the user:
  - **What** it is + **kind**: from `type`, or inferred (bug fix, feature, docs change, chore/refactor).
  - **Status**, plus **Done when** + **Out of scope** if present: the acceptance bar + boundaries. Honor them.
  - Never silently widen scope past an explicit Out of scope.

## Step 3: Classify

Metadata `spec` = the switch `create-todo` set when filing:

- `spec: full-plan`: body is a complete plan (Problem / Plan / Tests / Done-when, real pointers). Plan from it.
  Cited `file:line` locations drift: strong hints only, confirm they are current before editing.
- `spec: guidelines`: direction + intent only, deep planning left to you. Investigate: read referenced code, grep real
  call sites, anything broad → spawn an independent research or planning agent (tool mapping). Plan on facts.
- No header: judge by shape. Full Problem/Plan/Tests/Done-when with real pointers = `full-plan`.
  Loose pointer or a list of "figure out X" = `guidelines`.
- Either way step 6 presents a plan. `spec` only decides how much digging precedes it.

## Step 4: Tests / docs / fuzzing obligations

`type` orients: `fix` / `feature` always need tests, `docs` may need none, only `feature` gets the fuzzing check.

Tests: required for every fix + every feature. A rule: the PR-readiness gate rejects an untested one. Pick the layer:

- Vitest (`.spec.ts`) in the package's `test/` dir, mirroring `src/`.
- New block kind or operation → a test per row of the grid it touches (see `docs/architecture.md`).
- Pure docs or chore todo may have no code test: say so explicitly, never skip silently.

Test infra: check it, never assume it.

- Per planned test: name where it runs (this host, CI) + what it needs. Confirm in `.github/workflows/ci.yml`, SETUP.md.
- Missing piece (browser install, VS Code download, pack-and-install job) → built in this todo,
  per "Test infrastructure" in `docs/milestones/README.md`. Part of the plan, not a follow-up.

Docs: decide when clear, ask (question tool) when not.

- `docs/spec.md` (what), `docs/architecture.md` (how pieces fit, with graphics), `docs/plan.md` (in which order).
- Change to behaviour / structure / order → update the matching one. Name the file AND the section in the plan.
- Changed graphic → edit its HTML under `docs/assets/src/`, run `pnpm devx docs-images`.
- `publicdocs/` changes only when a page already describes behaviour this todo changes.
  New public pages = the milestone docs writer's job.

Fuzzing: features only. Judge candidacy, then propose.

- Code that rewrites text and keeps offsets (block splitter, scope step, position maps) usually has a cheap oracle.
- Gut-check for one:
  - round-trip: an encode/decode or serialize/parse pair returns the value.
  - do-it-twice / determinism: same input, same output (e.g. same scope id on every machine).
  - compare-to-a-trusted-source: one implementation against another (e.g. a block's offsets vs `source.slice`).
  - reject-bad-input: malformed input always rejected, never mis-accepted.
- Has one → propose with the question tool, get a yes before adding it to the plan. Never add it unilaterally.
  Never design the fuzzer here: the fuzzy-testing skill drives that discovery.
- No cheap oracle → say so, move on. Talking a feature out of fuzzing is a fine outcome.

## Step 5: Refine open questions (only if needed)

- Genuine forks left by step 3 or 4 (design choice the spec did not settle, ambiguity the code does not answer)
  → resolve with the user now, one focused question at a time.
- Never ask what reading the code answers. Ground every question in what you found.

## Step 6: Present the plan (always)

Approval workflow in [the tool mapping](../TOOLS.md), even for a complete spec: author-planned is not user-approved,
and the user gets to amend before any code. State concisely:

- the change + key files (from the spec's own pointers),
- **test** plan: package, what tests pin, where they run, infra this todo adds for them,
- **docs** plan: page + existing or new section, or explicit "no docs needed because …",
- **fuzzing** decision: proposed + confirmed, or "not a fuzz candidate because …",
- **finish**: run the gate, then `git mv` the spec into `docs/done/`.

Mirror the todo's **Done when** so approval is measured against the author's bar. Wait for approval.
User amends → fold it in, re-present.
