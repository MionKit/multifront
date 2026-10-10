---
type: chore
spec: guidelines
status: ready
created: 2026-10-10
---

# `pnpm devx` cannot launch its tools on Windows

## Intent

`scripts/devx.mjs` runs every tool with `spawnSync(join(REPO_ROOT, 'node_modules', '.bin', name), args)` and no
shell. On Windows, `.bin/<name>` is a POSIX shell shim and the runnable one is `<name>.cmd`, which Node refuses to
spawn without `shell: true`. So `pnpm devx test`, `lint`, `format` and `check` fail to launch there. The CI `windows`
job works around it with `pnpm exec vitest`. A contributor on Windows cannot run the repo's one dev CLI, and the
Windows job cannot use the same command as the `check` job.

## Direction

- Option: spawn `process.execPath` with the tool's JS entry, read from its package's `bin` field, so no shim and no
  shell are needed on any OS. Avoid `shell: true` with an args array (unescaped args, deprecated in recent Node).
- Then switch the CI `windows` job's test step to `pnpm devx test packages/core/test/context.spec.ts`.
- The implementer plans the details.

## Docs

`docs/milestones/README.md` "Test infrastructure" (the Windows paths row says devx does not run on Windows yet);
`SETUP.md` only if it gains a Windows note.

## Done when

- `pnpm devx test` launches vitest on `windows-latest`, and the `windows` CI job uses it.
- The simplify-comments pass ran on every touched source file, committed on its own.
