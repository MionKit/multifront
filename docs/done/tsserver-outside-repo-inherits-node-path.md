---
type: fix
spec: guidelines
status: done
created: 2026-10-11
---

# tsserver: the "project outside the repo" cases see the repo's packages through NODE_PATH

## Intent

`packages/e2e/editor/tsserver.spec.ts`, test "the TypeScript plugin in a project outside the repo: no
@vue/compiler-sfc, svelte by default > completion after $style. has no card: the scss module is not read", fails every
time Vitest starts through pnpm's bin shim (`pnpm vitest run …`, `pnpm exec vitest`, an editor's test runner):

```
AssertionError: expected [ 'card' ] to not include 'card'
 ❯ editor/tsserver.spec.ts:203:59
```

It passes under `pnpm devx test` and in CI. Cause found on 2026-10-11: `node_modules/.bin/vitest` exports
`NODE_PATH=…/node_modules/.pnpm/node_modules:…`, the spawned tsserver inherits it, and from there the project in
`os.tmpdir()` resolves `@vue/compiler-sfc` after all. So the case does not test what its name says whenever a
contributor runs Vitest the common way.

## Direction

- The tsserver the "outside the repo" cases start must not inherit `NODE_PATH` (or any other lookup path into the
  repo). Likely in `packages/e2e/editor/lib/tsserver.ts`, where the child is spawned.
- Check the other helpers that spawn a process "outside the repo" for the same leak.
- Prove it: the case passes under `pnpm vitest run --project e2e packages/e2e/editor/tsserver.spec.ts` and
  `pnpm devx test`. Do not loosen or skip the test.

## Docs

None, because this is test infra only.

## Done when

- The case passes however Vitest is started, and the cause is named in the moved spec.
- The simplify-comments pass ran on every touched source file, committed on its own.

## Plan: drop NODE_PATH from the spawned tsserver (approved 2026-10-11, automatic mode, delegated session)

- `startTsserver` in `packages/e2e/editor/lib/tsserver.ts` spawns tsserver with `env: {...process.env, NODE_PATH: undefined}`,
  for every case: no in-repo case needs `NODE_PATH`, as `pnpm devx test` and CI already run without it.
- Other helpers that spawn a process outside the repo (`devx/launch.spec.ts`, `editor/lib/vsix.ts`, `editor/vsix.spec.ts`)
  checked: devx finds tools by file path, never through `NODE_PATH`, and they pass under the bin shim. No change.

## What shipped

- Cause: `node_modules/.bin/vitest` (pnpm's bin shim) exports `NODE_PATH=…/node_modules/.pnpm/node_modules:…`; the spawned
  tsserver inherited it, so the project in `os.tmpdir()` resolved `@vue/compiler-sfc`.
- Fix as planned. The case passes under `pnpm vitest run --project e2e packages/e2e/editor/tsserver.spec.ts` and
  `pnpm devx test`; the other tsserver suites (`bundle`, `imports`, `blockImports`) pass under the bin shim too.
