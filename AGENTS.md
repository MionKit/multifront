# multifront Guidelines

> ⚠️ Reply to the user in plain everyday language, extremely condensed phrases. Avoid jargon.
> Term could be unclear → define it in one short sentence, plus a tiny code example when it helps.
> Never use em dashes "—"
> Do not load linked files into context unless the current task needs them!

- What we build: [docs/spec.md](docs/spec.md). How pieces fit: [docs/architecture.md](docs/architecture.md).
- How + in which order: [docs/plan.md](docs/plan.md). Setup + every command: [SETUP.md](SETUP.md).
- Package rules: [packages/AGENTS.md](packages/AGENTS.md). Read before any code, test or dep change in `packages/`.

## Assistant support

- Claude Code + Codex share this file and `.agents/skills/`. Claude finds them via the `.claude/skills` symlink.
- Read the matching `SKILL.md` before using a skill. Tool mapping: [.agents/skills/TOOLS.md](.agents/skills/TOOLS.md).

## Skills

- [create-todo](.agents/skills/create-todo/): write a request up as a `docs/todos/` spec.
- [implement-todo](.agents/skills/implement-todo/): build a todo end to end: plan, code, review, comments, PR, green CI.
- [run-milestone](.agents/skills/run-milestone/): run a whole milestone alone: one agent + one PR per step,
  then one QA pass, one fixer and the public docs.
- [review-pr](.agents/skills/review-pr/): review a branch or PR in a fresh `pr-reviewer` agent.
- [delegate-finding](.agents/skills/delegate-finding/): hand an unrelated bug to a parallel session.
- [fuzzy-testing](.agents/skills/fuzzy-testing/): add a seeded random-input test.
- [simplify-comments](.agents/skills/simplify-comments/): cut comments to one line that says what the code cannot.
- [multifront-setup](.agents/skills/multifront-setup/): install or verify Node, pnpm and packages on Claude web.
- [compact-agent-docs](.agents/skills/compact-agent-docs/): shrink AGENTS.md and skill files under the
  `pnpm devx agent-docs` limit, no rule lost.

## ⚠️ Any issue found during a task is FIXED, not filed for later

- **Related to the current task** → fix it in the same PR, own commit, own test.
- **Unrelated** → hand it to a parallel session with the [delegate-finding skill](.agents/skills/delegate-finding/).
- Unrelated + no parallel session possible → file it as a [docs/todos/](docs/todos/) spec in the same PR.
- Never let it slide.

## ⚠️ A removed thing leaves NO trace

- Removed/renamed option, export, flag, env var or subpath → no alias, no "was renamed" warning.
- No test for it, no doc line naming the old name. History lives in git and `docs/done/` only.

## Testing

**Test the real thing, end to end.** No unit tests of internals, no mocks, no stubs, no fake data.

- Every test feeds real files (real `.ucf` components, real apps) through real tools, checks the real output.
- Real tools = Vite, the framework plugins, TypeScript, the language server, a browser.
- Two tools meet (our plugin + plugin-vue, a parser + a compiler) → the test runs both for real.
- Smallest allowed test: a real fixture file, through a public function or command, real output checked.
- Fuzz tests only as generated real files: real fixtures mutated or recombined, run through the real tools.
- Cross-package e2e: private `packages/e2e`, a folder per area (build, browser, editor, consumer, devx), fixtures.
- **Missing test infra is built, never skipped around.** Test needs what CI/host lacks (browser, VS Code,
  packed tarball) → that piece comes in the same PR.
- e2e layout + "Test infrastructure": [docs/milestones/README.md](docs/milestones/README.md).
- Never report a test as passing from a run where it did not execute.
- **Vitest**. Test files: `.spec.ts` in each package's `test/` dir, mirroring `src/`, never beside the code.
- `pnpm devx test` runs every project. Root [vitest.config.ts](vitest.config.ts) = the one list of projects.
- New package → in `vitest.config.ts` AND, if published, root `tsconfig.json` references. Forget → typecheck fails.

## Code style

- No `I` prefix on interfaces; no `T` prefix on type parameters. `import type` for type-only imports.
- Shared types live in the package's `types.ts`; a type private to one file stays in that file.
- No `@param` / `@returns` in JSDoc; prefer one-line comments and one-line `if`s.
- **A comment earns its line or it goes.** Keep only what code can't say: reason, constraint, required order, invariant.
- **Every comment is one line.** Only multi-line comment: a file header, one paragraph max.
- Meaningful names; no one-letter names except loop indices and `err`.

## Development workflow

- Before committing: `pnpm devx check` (or at least `pnpm devx lint` + `pnpm devx format`).
- `pnpm devx format` = the only formatter run: oxfmt over `packages/**/*.ts` + `packages/**/*.md`.
  Never hand-format, never widen its scope.
- New command → row in `scripts/lib/registry.mjs` + handler in `scripts/devx.mjs`.
- Pre-commit hook runs `lint-staged`; commit-msg hook runs commitlint.
- Every env var the repo reads: `REGISTRY` in [scripts/lib/env.mjs](scripts/lib/env.mjs). `pnpm devx env` prints it.
- Prefix project-owned vars with `MULTIFRONT_`. `.env` is local only; `.env.sample` lists the user-settable ones.

## PR readiness

- New/changed behaviour has Vitest coverage, and `pnpm devx check` passes.
- Plan decision changes → update [docs/plan.md](docs/plan.md).
- Structure changes → update [docs/architecture.md](docs/architecture.md) + its graphics.
- Graphics: HTML under `docs/assets/src/`, rendered by `pnpm devx docs-images`. Commit HTML + PNG together.
- Public docs ([publicdocs/](publicdocs/)) = how to use multifront. Rules: [publicdocs/AGENTS.md](publicdocs/AGENTS.md).
- `public-docs-writer` agent writes them once per milestone. PR changes behaviour a public page describes → fix it too.
- PR implements a `docs/todos/` spec → `git mv` it into `docs/done/`, update it to match what shipped.
- **No other file ever names a `docs/todos/` or `docs/done/` document**: not a doc, a skill or a code comment.
  Those specs get deleted, so every such link rots.
- Comment pass on every touched source file: `comments-simplifier` subagent, never the session that wrote the code.
  [simplify-comments skill](.agents/skills/simplify-comments/SKILL.md). Committed on its own as `chore(comments): …`.

## Git workflow

- Branches: `feature/<name>`, `fix/`, `docs/`, `chore/`; a tool-given branch name is fine as is.
- Commit message: one Conventional Commits subject line; one short paragraph only when the why isn't in the diff.
- PRs land with rebase-and-merge → keep branches LINEAR. Integrate `main` by rebasing, never merging.
- After a rebase: `git push --force-with-lease`.
