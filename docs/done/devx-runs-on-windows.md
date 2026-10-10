---
type: chore
spec: guidelines
status: done
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

## Plan: run tool entries with node (approved 2026-10-10)

Delegated session, automatic mode: the delegation stood in for plan approval.

- `scripts/devx.mjs`: `bin(pkg, name)` reads the tool's entry from `node_modules/<pkg>/package.json` `bin`;
  `run` spawns `process.execPath` with that entry. No `.bin` shim, no shell, same path on every OS.
  All five tools (tsc, oxlint, oxfmt, vitest, commitlint) ship JS entries, so this covers every devx command.
  A tool missing from `node_modules` fails with `devx: <pkg> is not installed, run pnpm install`, not a stack trace.
- CI `windows` job: runs `pnpm devx format --check`, `pnpm devx lint`, then
  `pnpm devx test --project core --reporter verbose packages/core/test/context.spec.ts`.
  That job is the end-to-end test: devx launching oxfmt, oxlint, tsc and vitest on `windows-latest`.
  No Vitest spec for `scripts/`: one would run on Linux only and prove what the `check` job already proves.
- `docs/milestones/README.md` Windows paths row: names `pnpm devx test`, drops "devx does not run on Windows yet".
- `SETUP.md` unchanged: it gains no Windows note.
