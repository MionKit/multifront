---
type: fix
spec: guidelines
status: ready
created: 2026-10-12
---

# Flaky: vue-cache-miss "has nothing to do for the style sub-request of a `<style>` hot update"

## Intent

`packages/e2e/build/vue-cache-miss.spec.ts` › "the warm-up" › "has nothing to do for the style sub-request of a
`<style>` hot update" failed once in a full `pnpm devx test` run and passed in every other run. A test that fails at
random hides real failures and costs CI reruns, so find why and make it pass every time, without loosening what it
checks.

Seen while building milestone 5 step 5.3 (svelte target), on a branch that does not touch this test, its app or the
Vue code it drives:

- 1 failure in 1 full run (67 files, 2660 tests, about 120 s, the host busy with the whole suite).
- 0 failures in: 3 more full runs, 5 runs of the file alone, 2 runs of `packages/e2e/build/` alone.
- The failure's assertion message was not kept; the run printed only the test name.

## Direction

- The test edits `Counter.ucf` on disk, waits for `hotUpdatesOf(file).next()`, then transforms the style URL again and
  expects the new color with only one transform of the file. Suspects: the watcher seeing the write late or twice under
  load (a second `hotUpdate` or transform), or the `next()` promise settling on an earlier change.
- First reproduce: loop the file under load (for example beside the full suite, or with `--repeat`) and keep the
  assertion text.
- The implementer investigates and plans the fix; the test's checks stay as they are.

## Docs

None: test-only, no behaviour a doc describes.

## Done when

- The cause is named, fixed, and the test passes in a loop of runs under load (say 50) with no failure.
- The simplify-comments pass ran on every touched source file, committed on its own.
