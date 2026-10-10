---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 1
step: 1.3
---

# Milestone 1.3: splitter errors with exact locations

## Problem

`splitBlocks` (`packages/core/src/split.ts:72`) already skips bad structure but reports nothing: `errors` is always
`[]` (`split.ts:118`); stray text, unknown tags, unclosed blocks and comments are skipped up to the next `<`
(`split.ts:111`), and duplicate or missing targets go unreported. Spec 3.2 wants every structural error with an exact
location. M2 shows them in the editor, M3 turns them into build errors, and 1.5's fuzz rules rely on them (no errors
means the gaps are only whitespace and comments).

## Plan

1. **Locations**: a private `locate(source, offset)` in `split.ts` counts lines in `source.slice(0, offset)` (`\n`
   only, like Rollup's locator): 1-based line, 0-based UTF-16 column (Rollup / Vite `loc`). A private
   `report(code, start, end, message)` pushes a `Diagnostic` with `severity: 'error'` and the `filename` argument;
   every error, `missing-target` included, goes through it.
2. **Opening tag result**: `readOpeningTag` (`split.ts:21`) returns `{attrs, end}` plus a `broken` reason for a tag
   that never ends cleanly: `'eof'` (no `>` before end of file), `'open-quote'` (quote left open before `>` or a line
   break), `'self-closing'` (`/>`; `end` just after it). Replaces the bare `undefined`, so the caller can word the
   message and skip a self-closing unknown tag.
3. **`nextRootTag(source, from)`**, private: offset of the next `<name` whose name (same rule as today: runs to
   whitespace, `/` or `>`) is a root tag from `BLOCK_KINDS`, or `source.length`. The one resync point after a stray text
   run or an unclosed block.
4. **Gap loop in `splitBlocks`**, each case reports and recovers:
   - `unknown-root-tag`: `<` + letter, name not a root tag. Points at `<name` (`[start, nameEnd)`). Self-closing →
     skips past `/>`. Otherwise skips to the end of the first `</name` followed by `>` or whitespace (same browser
     raw-text rule as `findClosingTag`, `split.ts:60`) when it comes before `nextRootTag`, else resyncs at
     `nextRootTag`: a closing tag inside a later root block never swallows that block, and the content of a tag left
     open is not reported again. Message `<angular> is not a root tag; use <style>, <vue>, <react> or <svelte>`
     (list built from `BLOCK_KINDS`).
   - `unclosed-block`: a root tag that is broken (2) or has no closing tag. Points at the whole opening tag
     `[start, opening end)`, or `<name` when the tag never ends. Block left out of `blocks`; the scan resyncs at
     `nextRootTag` after the opening tag, so later blocks are still found and the presumed content is not reported
     again. Messages: `<react> is never closed; add </react>`; `'eof'` → `<react> opening tag has no '>'`;
     `'open-quote'` → `<style> has an attribute quote left open`; `'self-closing'` → `<style/> cannot self-close;
     write <style></style>`.
   - `duplicate-target`: second (and any later) block of one target. Points at its opening tag
     `[start, contentStart)`. All stay in `blocks`; `targets[tag]` stays the first. Message
     `<react> appears more than once; keep one`.
   - `missing-target`: `start = end = 0` (line 1, column 0), only when no target opening tag appears at all, closed or
     unclosed: one error per mistake, so `UnclosedReact.ucf` gives only `unclosed-block`. Message
     `No target block; add a <vue>, <react> or <svelte> block` (list built from the target kinds).
   - `text-outside-block`: a run starting at a char that is not whitespace, not a tag start, not a closed comment (an
     unclosed `<!--` starts one), up to `nextRootTag`, trailing whitespace trimmed (`end` just after the last
     non-space char); skipped. Messages: generic `Text outside a block; move it into a block or an HTML comment`;
     unclosed comment `HTML comment is never closed; add -->`; a run right after a block of type T, not itself starting
     with `</T` (a doubled closing tag gets the generic message), containing a `</T` closing tag (spec 10 limitation) `'</react>' in the <react> block closed it early; write '<\/react>' instead`.
   - Errors stay in `start` order (`missing-target` at 0 first).
5. **Invalid fixtures** in `packages/e2e/fixtures/components/invalid/`, each holding one kind of structural error,
   otherwise valid TSX / CSS:
   - `UnknownRootTag.ucf`: `<react>`, `<angular>…</angular>`, `<react_old>…</react_old>`, `<style scoped>` → two
     `unknown-root-tag` (the second at `<react_old`: one unknown tag, not `<react>` with an `_old` attribute); keeps
     react, style.
   - `UnclosedReact.ucf`: `<react>` with no `</react>`, then `<style scoped>` → `unclosed-block` at 1:0; keeps style.
   - `DuplicateReact.ucf`: three `<react>` + `<style scoped>` → `duplicate-target` at the second and the third; keeps
     every block; `targets.react` is the first.
   - `StylesOnly.ucf`: `<style scoped>`, `<style module>` → `missing-target` at 1:0, `start = end = 0`.
   - `TextOutsideBlock.ucf`: `<react>`, an indented stray line, `<style scoped>` → `text-outside-block` at column 2.
   - `ReactCloseInString.ucf`: `const closing = '</react>';` in the TSX → block closes there; the rest up to the real
     `</react>` is one `text-outside-block` at the column just after the string's `</react>`, message names
     `'<\/react>'`; keeps react (cut), style.
   - `BrokenOpeningTags.ucf`: `<react>` block, `<style scoped/>`, `<style lang="scss>` (open quote), a last `<style`
     with no `>` → three `unclosed-block`, one per `broken` reason. A quote closes later in the file, so only the
     "quote runs past `>` or a line break" rule catches the open one.
   - `BrokenUnknownTags.ucf`: `<div>` left open before a `<react>` block holding `</div>`, `<baz x="open`, a
     `<style scoped>`, then `<foo/>` and a stray line → three `unknown-root-tag` and one `text-outside-block`; keeps
     react, style.
   - `StrayClosingTag.ucf`: a doubled `</react>` after the block → one `text-outside-block` with the generic message.
   - `UnclosedComment.ucf`: `<react>`, `<!-- note` with no `-->`, `<style scoped>` → one `text-outside-block`
     (comment message); keeps style.
6. **Milestone doc**: `- Status: done` as last line of 1.3; the 1.3 table rows say what shipped (`unclosed-block`
   resync, the text run's end, `missing-target` only when no target tag appears, an unknown tag with no closing tag);
   the new fixture names in the 1.3 list and the "Invalid components" row of "Hands to later milestones".

## Tests

`packages/core/test/split.spec.ts`, a new `describe('splitBlocks on invalid fixtures')`, fixtures read by the same
relative path. Runs on this host and in CI's `check` job (`pnpm devx test`); needs only what 1.2 uses, no new infra.

- `listComponents('invalid')` equals the sorted fixture list (first caller of the folder argument).
- Hand-written table `{fixture, errors: [{code, line, column}], blocks}`: `errors` match exactly, and
  `split.blocks.map((block) => block.type)` equals the kept types.
- Every error: `severity === 'error'`, `filename === split.filename`, `0 <= start <= end <= source.length`,
  `line` / `column` equal the position of `start` counted in the test from `source.slice(0, start)`, one-line message.
- `ReactCloseInString.ucf` message contains `'<\/react>'`; `StrayClosingTag.ucf` message does not.
- `DuplicateReact.ucf`: `targets.react === blocks[0]`, errors at the second and third blocks.
- `UnknownRootTag.ucf`: the error at `<react_old` spans exactly `<react_old`.
- `BrokenUnknownTags.ucf`: the kept `<react>` block holds `</div>`.
- Every kept block still meets the 1.2 slice checks.
- File snapshot of the full `errors` per fixture, `test/__snapshots__/split/invalid/<Name>.ucf.errors.json`, with
  `filename` written as the fixture name so it is machine-independent; checked by hand.
- Existing valid-fixture tests still assert `errors` is `[]`.

## Docs

- `docs/spec.md` 3.2: error list adds text outside a block; errors carry a line and a column.
- Milestone doc: as in Plan 6.
- `docs/architecture.md`, `docs/plan.md`, `SETUP.md`, `publicdocs/`: none (no structure or order change, no public
  page describes the splitter yet).

## Fuzzing

None here: step 1.5 is the splitter fuzz test; its rules 2, 3 and 5 rely on this step.

## Decisions

- Orchestrator amend: `<react_old>…</react_old>` in `UnknownRootTag.ucf` with its own table row, so all four 1.2
  splitter fixes (unclosed `<!--`, open quote, `<style/>`, `<react_old>`) are pinned by a test.
- Extra fixtures `BrokenOpeningTags.ucf` and `UnclosedComment.ucf` (orchestrator: option A).
- Review: an unknown tag's closing tag counts only before the next root opening tag, else the scan resyncs there (a
  `<div>` left open swallowed a later `<react>` block; the content of a tag left open gave more errors). New fixtures
  `BrokenUnknownTags.ucf` and `StrayClosingTag.ucf`, a third block in `DuplicateReact.ucf`, a later closing quote in
  `BrokenOpeningTags.ucf`, and the duplicate message says "more than once".
- `missing-target` only when no target tag appears at all, one error per mistake (orchestrator: option A).
- After an unclosed block, resync at the next root opening tag (orchestrator: option A).
- Built: an unknown tag that never ends resyncs at the next root opening tag (the plan said its name end), one error
  per mistake like an unclosed block.

## Out of scope

- `check`, `checkBlocks`, the 1.4 codes and fixtures. The fuzz test (1.5). Any change to how valid files split.

## Done when

- `splitBlocks()` reports every structural error of spec 3.2 as a `Diagnostic` with exact offsets, line and column,
  and keeps every readable block; `split.spec.ts` passes on this host and in CI.
- `pnpm devx check` is green; the milestone step is marked done.
- The simplify-comments pass ran on every touched source file, committed on its own.
