---
type: fix
spec: guidelines
status: done
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

## Plan: atomic saves in the e2e tests (decided 2026-10-12, automatic mode, delegated session)

- Cause: `writeFile` empties the file, then writes it. The watcher reports the emptying; Vite's `read()` of an empty
  file waits about 100 ms for a newer mtime, then returns `''`. Under load the write lands later, so that first hot
  update hands plugin-vue an empty `Counter.ucf`. `hot.next()` settles on it, the test asks for the style URL before
  the second hot update lands, our record holds `''`, so the warm-up runs and transforms the file a second time.
- Seen: a write split by a 400 ms pause gave a first hot update that read 0 bytes.
- Fix: `saveFile(file, source)` in `packages/e2e/fixtures/index.ts` writes a temp file in the fixtures `.tmp` dir and
  renames it over the target. The file goes from old to new text in one step: one hot update, full text.
- Same race wherever a test edits a file a watcher sees, so every such edit uses it: the dev server hot update tests
  (`vue-cache-miss`, `vue-sourcemaps`, `vue-hmr`, `hmr`), the `build --watch` edits (`vue-cache-miss`,
  `vue-sourcemaps`, `vue-scope-id`) and the browser tests' `editFile`. Edits with no watcher keep `writeFile`.
- No test check changed. Checked: the test 50 times beside a full `pnpm devx test` and 3 busy-loop processes, no
  failure; every touched file green, browser tests included.
