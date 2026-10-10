---
type: chore
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.5
---

# Milestone 1.5: splitter fuzz test over generated real files

## Problem

`splitBlocks` (`packages/core/src/split.ts:37`) and `checkBlocks` (`packages/core/src/blocks/index.ts:17`) are pinned
only by the hand-written fixtures of 1.2 to 1.4. M2, M3 and M7 trust their offsets blindly. A seeded fuzz run over
real fixtures, mutated and recombined, catches what nobody wrote by hand: an off-by-one offset, a block cut early,
a throw on truncated input. It must replay from one seed.

## Plan

1. **Env knobs.** `scripts/lib/env.mjs:19` `REGISTRY` gets two `scope: 'dev'` rows: `MULTIFRONT_FUZZ_SEED` (base
   seed of the fuzz tests; default fixed, so every run replays) and `MULTIFRONT_FUZZ_RUNS` (inputs per fuzz test,
   default 500). `.env.sample` gets both, commented out. `pnpm devx test` already loads `.env` before vitest
   (`scripts/devx.mjs:103`); vitest workers inherit the env. CI unchanged: the default seed is fixed.
2. **`packages/core/test/split.fuzz.spec.ts`** (new, one file: the runner has no other user), reading fixtures by
   relative path like `split.spec.ts`. Adapted from the fuzzy-testing templates, no library.
   - **Settings and randomness**: `fuzzSettings()` reads the two vars, defaults `DEFAULT_SETTINGS = {seed: 2026,
     runs: 500}`; it throws, naming the var, unless the seed is an integer from 0 to `0xffffffff` (`mixSeed` works on
     32 bits, so a larger seed would replay a smaller one) and the run count an integer of at least 1 (0 runs would
     pass having checked nothing). `mulberry32(seed)` and `mixSeed(base, label, index)` come from
     `seeded-runner.ts`; `createRandom(seed)` wraps one generator: `next()`, `int(max)`, `pick(list)`,
     `shuffle(list)`. Randomness is passed explicitly; `Math.random` is never swapped.
   - **Model of a file**: `Model = {gaps: string[], blocks: ModelBlock[], cut?: number}` with
     `ModelBlock = Pick<Block, 'type' | 'content' | 'attrs'> & {open, close, intact}`, built from `splitBlocks` of the
     unmutated fixture (pinned by 1.2's snapshot test). `build(fixture, actions)` renders it into a case
     `{fixture, actions, applied, source, placed?}`: `applied` lists the actions that took effect, `placed` gives
     every model block its expected offsets. "Damaged" = `applied` holds `delete-close`, `close-in-string` or
     `truncate`.
   - **Input maker** (`caseAt(seed, runIndex)`, seeded by `mixSeed(seed, 'run', runIndex)`): a pick from
     `listComponents()`, then 1 to 4 actions `{kind, seed}`. Each kind is drawn among those that apply to the current
     state and applies with its own sub-seed, so a dropped action leaves the others replayable:
     - `shuffle`: permute the blocks, gaps stay in place (needs 2 blocks).
     - `gap`: insert whitespace (mix of ` `, `\t`, `\n`, `\r\n`) or an HTML comment taken from a real fixture's gaps
       (today `TsxEdges.ucf`'s) at the start or end of a gap, never inside an existing comment.
     - `requote`: rebuild one opening tag from its attrs: each valued attr double-quoted, single-quoted or unquoted
       (only when the value has no space, quote, `=`, `<`, `>`, backtick and is not empty), random spaces around
       `=`, random whitespace (newlines included) as separators and before `>`. Model attrs unchanged.
     - `recombine`: insert `\n  <line>;` at the top of a `<react>` block. Donor lines = trimmed lines of
       `TsxEdges.ucf`'s real `<react>` block that parse alone as TSX and hold no `</react` followed by whitespace or
       `>`, so the block can neither close early nor stop parsing (the `;` keeps the next line a statement of its
       own), and stays `intact`.
     - `duplicate`: copy a target block (`open + content + close`) to a random block slot, with a `\n\n` gap.
     - `delete-close`: drop one block's closing tag; the block is no longer `intact`.
     - `close-in-string`: insert `</react>` right after the opening quote of a quoted run (`/'[^'\n]*'|"[^"\n]*"/`) in
       a `<react>` block (needs one); the block is no longer `intact`.
     - `truncate` (at most once): a fraction of the length, applied to the rendered text, so the cut lands in the final
       file whatever the action order. A block straddling the cut is not `intact`; blocks after it leave the model.
   - **Rules**: `check*(case, outcome) → Violation[]`, gathered by `checkCase(case, splitter)`, which also turns a
     throw into the `never-throws` violation. Rule names form the `Rule` type. Rules 4 and 5 need `placed`; rules 1
     to 3 also run on raw shrunk text.
     1. `never-throws`: `splitBlocks` and `checkBlocks` never throw.
     2. `positions`: every `checkBlocks` diagnostic has `0 <= start <= end <= source.length`, and `line` / `column` are
        the position of `start` (lines split on `\n`, 0-based UTF-16 column: 1.3's convention).
     3. `structure` (no `split.errors`): blocks sorted, no overlap; `source.slice(start, contentStart)` matches
        `^<type(\s[^]*)?>$`, `source.slice(contentEnd, end)` matches `^</type\s*>$`,
        `content === source.slice(contentStart, contentEnd)`; every gap matches `^(\s|<!--[^]*?-->)*$`; gaps plus
        block slices joined equal `source`.
     4. Untouched blocks, two rule names:
        - `untouched`: the intact prefix of the model (blocks before the first non-intact one) is the start of
          `split.blocks`, field for field (`type`, `attrs`, `content`, offsets, `index` counted within the prefix).
          Any other intact model block the splitter returns at its exact `start` has the model's fields.
        - `parses`: whatever `<react>` block the splitter returns at an intact `<react>` block's start parses with the
          real TypeScript parser with zero syntax errors (`tsxSyntaxErrors`, memoised by content). It reads the
          splitter's content, not the model's, so it fires on a block cut early on its own.
     5. `known-outcome`:
        - (a) no damage: `split.errors` is exactly one `duplicate-target` per non-first copy of a target, at its
          opening tag, and `checkBlocks` adds nothing.
        - (b) with damage: each non-first copy of a target inside the intact prefix still has its `duplicate-target`.
        - (c) a deleted closing tag that is the only damage, with no `</tag` + `>`/whitespace after its opening tag:
          `unclosed-block` at that block's start.
   - **Shrinker** (`shrink(case, stillFails)`): one pass that drops actions one at a time (staying on the same index
     after a drop) while the same rule still fails and the file gets no longer (dropping a truncation would lengthen
     it). Then, for rules 1 to 3 only, drop line chunks of the rendered text (halves, then single lines) while the
     same rule still fails on the raw text.
   - **Runner**: `fuzz(splitter, settings, onlyRule?)` runs `caseAt` for each run, stops at the first case with a
     violation and returns `{seed, runIndex, runSeed, input, shrunk, violations}` or `undefined`. `onlyRule` keeps
     one rule's violations, for the negative controls.
   - **`describeFailure(failure)`**: the message the test fails with: run index and run seed, each violation, the
     replay line `MULTIFRONT_FUZZ_SEED=<seed> MULTIFRONT_FUZZ_RUNS=<runIndex+1> pnpm devx test
     packages/core/test/split.fuzz.spec.ts`, then fixture, applied actions and source of the input and of the shrunk
     case. It reaches the reader through the assertion message (`no-console` is an oxlint error), so CI's test
     output shows it too.
3. **Tests in the file**:
   - `holds every rule over <runs> generated files (seed <seed>)`: the main run with `fuzzSettings()`.
   - `reaches every case`: default settings, `caseAt` plus `splitBlocks` only. Every action kind applies at least
     once, and each rule's premise is met at least once: an error-free file (3), a damaged file with a non-empty
     intact prefix (4), an intact block after damage returned at its start (4), an undamaged file and an undamaged
     file with a duplicated target (5a), a duplicate inside the intact prefix of a damaged file (5b), 5c's premise.
     It ignores the env knobs, so a short `MULTIFRONT_FUZZ_RUNS` never fakes coverage.
   - `shrinks to the fewest actions and lines that still fail`: `Hello.ucf` with gap, duplicate, requote and shuffle,
     shrunk against "two `<react` tags", gives the `duplicate` action alone and the text `<react>\n<react>\n`.
   - `env knobs`: `7` / `30` are read; `x`, `4294967296` (seed), `0` and `-3` (runs) throw, naming the var.
   - `negative controls`: each runs `fuzz` over a deliberately broken wrapper around the real `splitBlocks`, keeping
     only the named rule's violations (so that rule alone must catch the bug). It expects that rule, a shrunk input
     that still fails it and is no longer than the original, the replay line, and that replaying with
     `runs: runIndex + 1` finds the same input:
     - throws when the trimmed source does not end with `>` (a throw on truncated input) → `never-throws`
     - `column + 1` on every error → `positions`
     - `contentStart + 1` on every block, content re-sliced (off-by-one) → `structure`
     - `index + 1` on every block → `untouched` (the intact prefix)
     - a wrong attribute on blocks after the first error that is not `duplicate-target` → `untouched` (intact
       blocks after damage)
     - each `<react>` block's content loses its last line (cut early) → `parses`
     - `duplicate-target` filtered out → `known-outcome` (5a)
     - `duplicate-target` filtered out only when the file has another error → `known-outcome` (5b)
     - `unclosed-block` filtered out → `known-outcome` (5c)
     - `lang: 'nope'` on every `<style>` block, so `checkBlocks` adds `unknown-style-lang` → `known-outcome` (5a)
4. **A failure found while building**: fix it in `split.ts` / `scan.ts` (own commit), save the shrunk file as
   `packages/e2e/fixtures/components/fuzz/<Name>.ucf` with a row in `INVALID_CASES`
   (`packages/core/test/split.spec.ts:81`) or `CHECK_CASES` (`check.spec.ts`), and make the fixture listings
   (`split.spec.ts:159`, `check.spec.ts:44`) cover `fuzz/` too. No `fuzz/` folder when the run is clean.
   Shipped: the default run plus 100,000 runs over seeds 1 to 5 found no failure, so no `fuzz/` fixture and no
   splitter change.

## Tests

- `packages/core/test/split.fuzz.spec.ts` (core vitest project, already includes `test/**/*.spec.ts`). Runs on this
  host and in CI's existing `Test` step (`pnpm devx test`, `.github/workflows/ci.yml`). Needs only Node and the
  installed `typescript`. No new infra beyond the env knobs.
- Pins the five rules over 500 generated files, that the input maker reaches each rule's case, the shrinker, the env
  knobs, and a negative control per rule clause showing each catches the bug it is built for.
- Budget: split + check take microseconds per file, TypeScript parses are memoised. The file runs well under 10 s.

## Docs

- `docs/milestones/m1-splitter-block-kinds-styles.md` step 1.5: `- Status: done`, rule 5's
  deleted-closing-tag outcome made sound as 5(c) (see Decisions). "Hands to later milestones": the fuzz knobs row
  stays.
- `SETUP.md:47`: one line on replaying or lengthening a fuzz run with the two env vars.
- `docs/spec.md`, `docs/plan.md`, `docs/architecture.md`: none, no behaviour, order or structure change.
  `publicdocs/`: none.

## Fuzzing

This step is the fuzz test, built with the fuzzy-testing skill's runner and shrinker templates. Every rule is grounded
in spec 3.2 and the 1.2 to 1.4 step text, and proven by a negative control.

## Decisions

- Rule 5's "a deleted closing tag gives at least one error" is unsound: a later `</style>` or a duplicated
  `</react>` closes the block legally (browser `<script>` rule), with zero errors. Replaced by 5(c), and 5(a) made
  exact; step text updated to match (orchestrator: approved).
- `type: chore`: a test plus env knobs, no user-facing change (orchestrator: approved).
- Runner first planned in `packages/core/test/fuzz.ts`, no hand-off row (orchestrator: approved). Review found it had
  one user, so it lives in the spec file; M3 plans its own harness in `packages/e2e/build/`.
- Negative controls stay as permanent tests over a broken wrapper of the real `splitBlocks` output (orchestrator:
  approved).

## Out of scope

- The hand-run soak workflow (`docs/milestones/README.md`, "later").
- Fuzzing other modules (M3 scope transform, M7 position maps).
- New mutations beyond the step's eight.
- Changing splitter behaviour except to fix a bug the fuzz finds.

## Done when

- `pnpm devx test` runs `split.fuzz.spec.ts`: 500 runs green on the default seed, every negative control red as
  designed, coverage test green.
- A failure prints its seed and replay line; the two knobs are in `REGISTRY` and `.env.sample`.
- Any bug found is fixed, saved under `fixtures/components/fuzz/` with a table row.
- Milestone doc step 1.5 says `- Status: done` and matches what shipped; `pnpm devx check` is green.
- The simplify-comments pass ran on every touched source file, committed on its own.
