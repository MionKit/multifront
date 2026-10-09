# multifront Guidelines

> ⚠️ When replying to the user, talk in plain everyday language and extremely condensed phrases! Avoid jargon. If a term could be unclear, define it in one short sentence, and add a tiny code example when it helps.
> Never use em dashes "—"
> Do not load linked files into context unless the current task needs them!

What we are building: [docs/spec.md](docs/spec.md). How and in which order: [docs/plan.md](docs/plan.md).
Setup and every command: [SETUP.md](SETUP.md).

## Assistant support

Claude Code and Codex share this file and `.agents/skills/`. Read the matching `SKILL.md` before using a skill. Claude finds the same skills through the `.claude/skills` symlink. Tool mapping: [.agents/skills/TOOLS.md](.agents/skills/TOOLS.md).

## ⚠️ Any issue found during a task is FIXED, not filed for later

- **Related to the current task** → fix it in the same PR, with its own commit and its own test.
- **Unrelated** → write it up as a [docs/todos/](docs/todos/) spec in the same PR, or hand it to a parallel session. Never let it slide.

## ⚠️ A removed thing leaves NO trace

A removed or renamed option, export, flag, env var or subpath leaves no alias, no "was renamed" warning, no test for it and no doc line naming the old name. History lives in git and `docs/done/` only.

## JS monorepo (`packages/`)

One pnpm workspace, one `@multifront/*` namespace, one version (`version.json`) for every package.

- All `dependencies` / `devDependencies` are exact-pinned. `peerDependencies` are ranges.
- Cross-package deps use `workspace:*`.
- devDependencies live at the root. ONE exception: a package carries the devDependencies that satisfy its own peers (`@multifront/vite` carries vite, plugin-vue, vue).
- [core](packages/core/): bundler agnostic, NEVER imports Vite or a framework plugin.
- [vite](packages/vite/): the Vite plugin. Composes `@vitejs/plugin-vue` (peer), never forks or deep-imports it. Read "Building on plugin-vue" in [docs/plan.md](docs/plan.md) first.
- **Published READMEs stay thin**: a short description, the link to the repo, the status and license lines.

## Testing

- **Vitest**. Test files are `.spec.ts` in each package's `test/` dir, mirroring `src/`, never beside the code.
- `pnpm devx test` runs every project. The root [vitest.config.ts](vitest.config.ts) is the one list of projects.
- Adding a package means adding it to `vitest.config.ts` AND to the root `tsconfig.json` references. `pnpm devx typecheck` fails if you forget.

## TypeScript

- Each package has two configs: `tsconfig.json` (check + editor, no emit) and `tsconfig.build.json` (the emit half, the only place `dist/` appears).
- A cross-package import resolves through the `source` export condition, so nothing needs building before a check or a test.
- Imports use the `.ts` extension; the build rewrites it to `.js`.
- ESM only.

## Code style

- No `I` prefix on interfaces; no `T` prefix on type parameters.
- Shared types live in the package's `types.ts`; a type private to one file stays in that file.
- Use `import type` for type-only imports.
- No `@param` / `@returns` in JSDoc; prefer one-line comments and one-line `if`s.
- **A comment earns its line or it goes.** Keep it only if it says something the code cannot: a reason, a constraint, an ordering requirement, an invariant.
- **Every comment is one line.** The only multi-line comment is a file header, one paragraph at most.
- Meaningful names; no one-letter names except loop indices and `err`.

## Environment variables

[scripts/lib/env.mjs](scripts/lib/env.mjs) `REGISTRY` lists every env var the repo reads; `pnpm devx env` prints it. Prefix project-owned vars with `MULTIFRONT_`. `.env` is local only; `.env.sample` lists the user-settable ones.

## Development workflow

- Before committing: `pnpm devx check` (or at least `pnpm devx lint` and `pnpm devx format`).
- `pnpm devx format` is the only formatter run: oxfmt over `packages/**/*.ts` and `packages/**/*.md`. Never hand-format, never widen its scope.
- Adding a command means adding a row to [scripts/lib/registry.mjs](scripts/lib/registry.mjs) and a handler in [scripts/devx.mjs](scripts/devx.mjs).
- The pre-commit hook runs `lint-staged`; the commit-msg hook runs commitlint.

## PR readiness

- New or changed behaviour has Vitest coverage, and `pnpm devx check` passes.
- Docs updated: [docs/plan.md](docs/plan.md) when a plan decision changes.
- If the PR implements a [docs/todos/](docs/todos/) spec, `git mv` it into [docs/done/](docs/done/) and update it to match what shipped.
- Every touched source file gets a comment pass by the `comments-simplifier` subagent ([simplify-comments skill](.agents/skills/simplify-comments/SKILL.md)), never by the session that wrote the code, committed on its own as `chore(comments): …`.

## Git workflow

- Branches: `feature/<name>`, `fix/`, `docs/`, `chore/`; a tool-given branch name is fine as is.
- Commit messages: one Conventional Commits subject line; one short paragraph only when the why isn't in the diff.
- PRs land with rebase-and-merge, so keep branches LINEAR. Integrate `main` by rebasing, never merging, then `git push --force-with-lease`.
