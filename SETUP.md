# Setup

The one setup document: tools, install, and every dev command.

## Tools

- Node ≥ 26
- pnpm ≥ 11 (the repo pins the exact version in `package.json` → `packageManager`)
- git

## Install

```bash
pnpm install
pnpm exec husky     # wires the git hooks (install scripts are blocked, so this is manual)
```

Never `npm install`. Install policy (exact pins, 30-day minimum release age, no install scripts) lives in `pnpm-workspace.yaml`.

## Commands

Everything runs through `devx` ([scripts/devx.mjs](scripts/devx.mjs)), the same commands CI runs.

```bash
pnpm devx --help        # list commands
pnpm devx check         # everything CI runs: format --check, lint, test, build
pnpm devx lint          # oxlint, then typecheck
pnpm devx typecheck     # tsc per package, plus the build graph / test project check
pnpm devx test          # all vitest projects; extra args go to vitest
pnpm devx format        # oxfmt (add --check to only report)
pnpm devx build         # tsc --build into each package's dist/
pnpm devx clean         # delete dist/, coverage/, *.tsbuildinfo (--deps, --dry-run)
```

Single test file: `pnpm devx test packages/vite/test/vueCompiler.spec.ts`.
