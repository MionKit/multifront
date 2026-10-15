---
type: feature
spec: full-plan
status: ready
created: 2026-10-15
milestone: 7
step: 7.9
---

# Propose `.ucf` support to oxc, with a canary test

## Problem

oxlint skips `.ucf` files. So `mf-lint` (7.8) writes each block to a temp file, runs oxlint and maps the positions
back. That costs temp files, gives no cross-file rules (`import/no-cycle`), no type-aware linting, and no support in
oxc's own VS Code extension (milestone risk "Linting a block alone"). The fix belongs upstream: a `.ucf` loader in
oxlint. When it lands, `mf-lint` should become plain oxlint, and we need a test that tells us when that happens.

Checked before planning:

- oxc `main` (2c67197, 2026-10-15): `crates/oxc_linter/src/loader/partial_loader/mod.rs:20`
  `LINT_PARTIAL_LOADER_EXTENSIONS = ["vue", "astro", "svelte"]`. `PartialLoader::parse(ext, source)` returns
  `Vec<JavaScriptSource>`, each `JavaScriptSource::partial(text, source_type, start)` (`loader/source.rs`).
  `Loader::can_load` (`loader/mod.rs`) rejects any other extension. So a `.ucf` loader fits there: one `match` arm
  plus a `UcfPartialLoader`.
- Upstream already tracks pluggable loaders: issue #23207 "Oxlint Language Plugins implementation plan" (from RFC
  #21936: "custom file languages such as Vue, Svelte, Angular templates, GraphQL, JSON"). Our second option points at
  it instead of asking for a new feature.
- The repo's pinned oxlint 1.82.0 on `packages/e2e/fixtures/apps/lint-format/`
  (`node node_modules/oxlint/bin/oxlint -f json .`): exit 0, `number_of_files: 4` (the four `.ts` files), no
  diagnostics. With `--ignore-pattern '**/*.ucf'`: the same 4. With `--ignore-pattern '**/*.ts'`: 0, so the flag works
  and changes the count. If oxlint read `.ucf`, `Lint.ucf` and `Clean.ucf` would be counted (`Messy.ucf` is in the
  fixture's `ignorePatterns`) and `Lint.ucf`'s `debugger;` lines would be `no-debugger` errors.
- MionKit/multifront is public, so the issue can link our fixtures.

## Plan

1. **The upstream issue** on `oxc-project/oxc` (text below, sent as written). No upstream PR in this step: the issue
   offers one if the maintainers agree, and that answer comes days later. The canary test covers the time in between.
2. **`docs/plan.md`**, "### 7. Full editor support", the oxfmt / oxlint line: after "while proposing `.ucf` support to
   oxc upstream" add `([oxc-project/oxc#<n>](<issue url>))`.
3. **`packages/e2e/editor/lib/format.ts`**: export `OXLINT_DIR` (moved from
   `packages/e2e/editor/lint/mf-lint.spec.ts:21`, which then imports it) and `OXLINT = join(OXLINT_DIR, 'bin', 'oxlint')`,
   next to `OXFMT_DIR` / `OXFMT`.
4. **`packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts`**: one `it`. It runs the real pinned oxlint
   (`spawnSync(process.execPath, [OXLINT, '-f', 'json', ...args], {cwd})`, cwd = `join(FIXTURES_DIR, 'apps', LINT_FORMAT)`,
   read only, no copy) twice: `.` and `--ignore-pattern '**/*.ucf' .`. Checks:
   - both runs' stdout parses as oxlint's report (`{diagnostics, number_of_files}`);
   - the run linted something: `number_of_files > 0`;
   - no diagnostic's `filename` ends in `.ucf`, and both runs count the same `number_of_files`, with the message
     `oxlint now lints .ucf files (<the .ucf diagnostics>): compare its findings with mf-lint's on the same files,
     then switch mf-lint to plain oxlint`;
   - both exit 0, checked after the `.ucf` check, so the first failure on upgrade (`Lint.ucf`'s errors make oxlint
     exit 1) prints that message.
5. **Milestone doc**: `- Status: done` under 7.9. Nothing shipped differs from the step text.

Issue text:

````markdown
Title: linter: lint `.ucf` files (one component for Vue, React and Svelte)

[multifront](https://github.com/MionKit/multifront) compiles one `.ucf` file into a Vue, a React and a Svelte component.
We would like oxlint to lint `.ucf` files the way it lints `.vue`, `.svelte` and `.astro`: a loader next to the ones in
`crates/oxc_linter/src/loader/partial_loader/`.

### The format

```html
<!-- HTML comments may sit between blocks -->
<vue>
<script setup lang="ts">
defineProps<{ title: string }>()
</script>
<template><h2 :class="$style.card">{{ title }}</h2></template>
</vue>

<react>
export default function Card({ title }: { title: string }) {
  return <h2 className={$style.card}>{title}</h2>
}
</react>

<svelte>
<script lang="ts">
  let { title }: { title: string } = $props()
</script>
<h2 class={$style.card}>{title}</h2>
</svelte>

<style module>
.card { padding: 1rem }
</style>
```

Split rules ([spec 2 and 3.2](https://github.com/MionKit/multifront/blob/main/docs/spec.md#2-file-format)):

- Root blocks: `<vue>`, `<react>`, `<svelte>` (each at most once) and any number of `<style ...>`.
  Only whitespace and HTML comments sit between them. Opening tags may carry attributes (`<style module="classes" lang="scss">`).
- A block's content is raw text up to the first matching closing tag, like a browser `<script>`:
  the first `</react>` closes `<react>`, even inside a string. So the split never tokenizes TSX (`<>`, generics, `a < b`).

### What to lint per block

- `<react>`: the whole content is one TSX module, at the block's content offset.
- `<vue>`: the content is the inside of a `.vue` file: `VuePartialLoader` on it, its `start` offsets moved by the block's offset.
- `<svelte>`: the same with `SveltePartialLoader`.
- `<style>`: skipped.
- Every block may use `$style` without importing it (each `<style module="name">` adds `name`): the compiler injects them.
  We pass them as `globals` today.

### Today's workaround

`mf-lint` writes each block to a temp file (`Card.ucf.react.tsx`, `Card.ucf.vue.vue`, `Card.ucf.svelte.svelte`), runs
`oxlint -f json` and maps the spans back to the `.ucf` file. It works, but rules that follow imports (`import/no-cycle`)
and type-aware linting cannot see across the temp files, and the oxc VS Code extension does not lint `.ucf` files.

Fixtures and expected findings: [`packages/e2e/fixtures/apps/lint-format/Lint.ucf`](https://github.com/MionKit/multifront/blob/main/packages/e2e/fixtures/apps/lint-format/Lint.ucf)
and [`packages/e2e/editor/lint/mf-lint.spec.ts`](https://github.com/MionKit/multifront/blob/main/packages/e2e/editor/lint/mf-lint.spec.ts).
Our splitter: [`packages/core/src/split.ts`](https://github.com/MionKit/multifront/blob/main/packages/core/src/split.ts).

### Two options

1. A built-in `.ucf` loader as above. If you agree, we are happy to send the PR.
2. If a built-in loader is out of scope: would the language plugins of #23207 let a plugin map an extension to blocks
   (offset plus source type, or "load this part as Vue / Svelte")? Then we would ship the loader ourselves and gladly test the plugin API.

Formatting `.ucf` with oxfmt would be a later, separate request.
````

## Decisions

- Who posts the issue: the user, by hand, from their own account (orchestrator, option 1): a public post on a
  third-party repo is the user's own call. This session never attaches or writes to `oxc-project/oxc`.

## Tests

- `packages/e2e/editor/lint/oxlint-ucf-canary.spec.ts` (area Editor, Vitest project `e2e`). Real fixture, real pinned
  oxlint, no copy. Runs on this host and in CI's `check` job (`pnpm devx test`). Needs only the root devDependency
  `oxlint` 1.82.0, already installed. No new infra. Proof it can fail: the same oxlint with `--ignore-pattern '**/*.ts'`
  counts 0 files, so the count comparison reacts to files being linted or not.
- `mf-lint.spec.ts` stays green after `OXLINT_DIR` moves.

## Docs

- `docs/plan.md`, milestone 7: the issue link.
- `docs/milestones/m7-full-editor-support.md`: `- Status: done` under 7.9.
- spec, architecture: none. Spec 6.1 already names both options. publicdocs: none, no behaviour changes.

## Fuzzing

None: no input space. The canary checks one fact about a pinned tool.

## Out of scope

- An upstream PR (comes only if the maintainers agree, after this step).
- Proposing `.ucf` to oxfmt (the issue mentions it as a follow-up only).
- Changing `mf-lint`.

## Done when

- The issue is open on `oxc-project/oxc` and `docs/plan.md` links it.
- The canary spec passes on this host and in CI, and fails with its message when oxlint lints a `.ucf` file.
- `pnpm devx check` passes.
- The simplify-comments pass ran on every touched source file, committed on its own.
