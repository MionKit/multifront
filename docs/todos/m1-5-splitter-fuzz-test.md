---
type: chore
spec: full-plan
status: ready
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
2. **`packages/core/test/fuzz.ts`** (new helper beside `tsx.ts`), adapted from the fuzzy-testing templates, no library:
   - `fuzzSettings(): {seed: number; runs: number}`: reads the two vars; defaults `2026` / `500`; a value that is not
     a non-negative integer throws, naming the var.
   - `mulberry32(seed)`, `mixSeed(base, label, index)` (from `seeded-runner.ts`), and a `Random` wrapper over one
     generator: `int(max)`, `pick(list)`, `shuffle(list)`. Randomness is passed explicitly; `Math.random` is never
     swapped.
   - `runFuzz<Input>({seed, runs, generate(random), check(input) → Violation[], shrink(input, stillFails)})`: run `i`
     uses `mixSeed(seed, 'run', i)`; stops at the first input with a violation, returns
     `{runIndex, runSeed, input, shrunk, violations}` or `undefined`.
   - `describeFailure(failure)`: the message the test fails with: rule, message, base seed, run index, the replay line
     `MULTIFRONT_FUZZ_SEED=<seed> MULTIFRONT_FUZZ_RUNS=<runIndex+1> pnpm devx test packages/core/test/split.fuzz.spec.ts`,
     the fixture, the mutations and the shrunk file text. It reaches the reader through the assertion message
     (`no-console` is an oxlint error), so CI's test output shows it too.
3. **`packages/core/test/split.fuzz.spec.ts`** (new), reading fixtures by relative path like `split.spec.ts`.
   - **Model of a file**: `{fixture, gaps: string[], blocks: ModelBlock[], cut?: number}` with
     `ModelBlock = {type, open, content, close, attrs, intact}`, built from `splitBlocks` of the unmutated fixture
     (pinned by 1.2's snapshot test). Rendering gives the source and every model block's expected offsets.
   - **Input maker**: seeded pick from `listComponents()`, then 1 to 4 actions `{kind, seed}`. Each kind is drawn
     among those that apply to the current state and applies with its own sub-seed, so a dropped action leaves the
     others replayable:
     - `shuffle`: permute the blocks, gaps stay in place (needs 2 blocks).
     - `gap`: insert whitespace (mix of ` `, `\t`, `\n`, `\r\n`) or an HTML comment taken from a real fixture's gaps
       (today `TsxEdges.ucf`'s) at the start or end of a gap, never inside an existing comment.
     - `requote`: rebuild one opening tag from its attrs: each valued attr double-quoted, single-quoted or unquoted
       (only when the value has no space, quote, `=`, `<`, `>`, backtick and is not empty), random spaces around
       `=`, random whitespace (newlines included) as separators and before `>`. Model attrs unchanged.
     - `recombine`: insert one line of `TsxEdges.ucf`'s `<react>` content at the top of a `<react>` block. Donor lines
       = trimmed lines of that real block that parse alone as TSX (`tsxSyntaxErrors` = `[]`), so the block stays
       parseable and `intact`.
     - `duplicate`: copy a target block (`open + content + close`) to a random block slot, with a `\n\n` gap.
     - `delete-close`: drop one block's closing tag; the block is no longer `intact`.
     - `close-in-string`: insert `</react>` right after the opening quote of a quoted run (`/'[^'\n]*'|"[^"\n]*"/`) in
       a `<react>` block (needs one); the block is no longer `intact`.
     - `truncate`: cut the final text at a random offset. Always runs last whatever its draw order, so the cut lands in
       the final text. A block straddling the cut is not `intact`; blocks after it leave the model.
   - **Rules**, one `check*(case, outcome) → Violation | undefined` each. A case is `{source, model?}`; rules 4 and 5
     need the model, rules 1 to 3 also run on raw shrunk text.
     1. `never-throws`: `splitBlocks` and `checkBlocks` never throw.
     2. `positions`: every `checkBlocks` diagnostic has `0 <= start <= end <= source.length`, and `line` / `column` are
        the position of `start` (lines split on `\n`, 0-based UTF-16 column: 1.3's convention).
     3. `structure` (no `split.errors`): blocks sorted, no overlap; `source.slice(start, contentStart)` matches
        `^<type(\s[^]*)?>$`, `source.slice(contentEnd, end)` matches `^</type\s*>$`,
        `content === source.slice(contentStart, contentEnd)`; every gap matches `^(\s|<!--[^]*?-->)*$`; gaps plus
        block slices joined equal `source`.
     4. `untouched`: the intact prefix of the model (blocks before the first non-intact one) is the start of
        `split.blocks`, field for field (`type`, `attrs`, `content`, offsets, `index` counted within the prefix). Any
        other intact model block the splitter returns at its exact `start` has the model's content and offsets.
        Every matched `<react>` block's content parses with the real TypeScript parser with zero syntax errors
        (`tsxSyntaxErrors`, memoised by content).
     5. `known-outcome`:
        - (a) no damage (no `delete-close`, `close-in-string`, `truncate`): `split.errors` is exactly one
          `duplicate-target` per non-first copy of a target, at its opening tag, and `checkBlocks` adds nothing.
        - (b) with damage: each non-first copy of a target inside the intact prefix still has its `duplicate-target`.
        - (c) a deleted closing tag that is the only damage, with no `</tag` + `>`/whitespace after its opening tag:
          `unclosed-block` at that block's start.
   - **Shrinker**: drop actions one at a time, repeated until nothing more drops, while the same rule still fails.
     Then, for rules 1 to 3 only, drop line chunks of the rendered text (halves, then single lines) while the same
     rule still fails on the raw text. The failure shows the shrunk actions and the shrunk text.
   - **Tests in the file**:
     - `it('holds every rule over <runs> generated files')`: the main run with `fuzzSettings()`, fails with
       `describeFailure`.
     - `it('reaches every case')`: default seed, 500 runs, input maker plus `splitBlocks` only. Every action kind
       applies at least once, and the premise of each rule is met at least once: an error-free file (3), a damaged
       file with a non-empty intact prefix (4), an intact block after damage returned at its start (4), damage-free
       (5a), a duplicate inside the intact prefix of a damaged file (5b), 5c's premise. It ignores the env knobs, so a
       short `MULTIFRONT_FUZZ_RUNS` never fakes coverage.
     - `describe('negative controls')`: each runs the same loop over a deliberately broken wrapper around the real
       `splitBlocks` and expects the named rule among the violations, plus a shrunk input that still fails and is
       no longer than the original:
       - throws when the trimmed source does not end with `>` (a throw on truncated input) → `never-throws`
       - `column + 1` on every error → `positions`
       - `contentStart + 1` on every block, content re-sliced (off-by-one) → `structure`
       - each `<react>` block's content loses its last line (cut early) → `untouched`
       - `duplicate-target` errors filtered out → `known-outcome`
       - `unclosed-block` errors filtered out → `known-outcome`
4. **A failure found while building**: fix it in `split.ts` / `scan.ts` (own commit), save the shrunk file as
   `packages/e2e/fixtures/components/fuzz/<Name>.ucf` with a row in `INVALID_CASES`
   (`packages/core/test/split.spec.ts:81`) or `CHECK_CASES` (`check.spec.ts`), and make the fixture listings
   (`split.spec.ts:159`, `check.spec.ts:44`) cover `fuzz/` too. No `fuzz/` folder when the run is clean.

## Tests

- `packages/core/test/split.fuzz.spec.ts` (core vitest project, already includes `test/**/*.spec.ts`). Runs on this
  host and in CI's existing `Test` step (`pnpm devx test`, `.github/workflows/ci.yml`). Needs only Node and the
  installed `typescript`. No new infra beyond the env knobs.
- Pins the five rules over 500 generated files, that the input maker reaches each rule's case, and one negative
  control per rule (two for rule 5) showing each rule catches the bug it is built for.
- Budget: split + check take microseconds per file, TypeScript parses are memoised. The file runs well under 10 s.

## Docs

- `docs/milestones/m1-splitter-block-kinds-styles.md` step 1.5: `- Status: done`, name `test/fuzz.ts`, rule 5's
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
- Shared runner in `packages/core/test/fuzz.ts`, no hand-off row: M3 plans its own harness in `packages/e2e/build/`
  (orchestrator: approved).
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
