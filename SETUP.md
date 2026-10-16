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

### Claude Code on the web

[scripts/setup-claude-web.sh](scripts/setup-claude-web.sh) installs Node 26, the pinned pnpm, every package and the git hooks, and points `MULTIFRONT_CHROMIUM_PATH` at the image's Chromium when Playwright's own is missing.

- Paste the whole script into the web environment's **Setup script** field. It runs before each new session, and the environment cache keeps Node 26, the pnpm store and `node_modules`.
- Bump `SETUP_DATE` at the top of the script to force a fresh run.
- `bash scripts/setup-claude-web.sh --check` reports what is missing without installing anything.
- Network access it needs: `*.nodejs.org` and `registry.npmjs.org`.

## Commands

Everything runs through `devx` ([scripts/devx.mjs](scripts/devx.mjs)), the same commands CI runs.

```bash
pnpm devx --help        # list commands
pnpm devx check         # everything CI runs: format --check, lint, agent-docs, test, the core tests again from packages/core, build
pnpm devx lint          # oxlint, then typecheck
pnpm devx typecheck     # tsc per package, plus the build graph / test project check
pnpm devx agent-docs    # agent docs stay ≤ 100 lines, ≤ 120 chars per line
pnpm devx test          # all vitest projects; extra args go to vitest
pnpm devx format        # oxfmt (add --check to only report)
pnpm devx build         # tsc --build into each package's dist/
pnpm devx clean         # delete dist/, coverage/, *.tsbuildinfo (--deps, --dry-run)
pnpm devx docs-images   # render the docs graphics to PNG (Playwright)
pnpm devx consumer-pack <dir>  # build the e2e fixture library, pack one tarball per framework into <dir> (CI's consumer-pack job)
pnpm devx vsix          # bundle and pack the VS Code extension into packages/vscode/multifront-vscode-<version>.vsix
pnpm devx commitlint    # check commit messages (CI: --from <base> --to <head>; the commit-msg hook: --edit)
pnpm devx peer-floor vue    # CI only: install the oldest react, vue or svelte versions @multifront/vite supports (rewrites the lockfile)
```

Single test file: `pnpm devx test packages/vite/test/vueCompiler.spec.ts`. One e2e area: `pnpm devx test packages/e2e/build`.

The editor exit test (`packages/e2e/editor/vscode/`) runs a real VS Code. Its first run downloads the pinned build into `.vscode-test/` (about 360 MB). On Linux with no display it starts its own Xvfb, so install `xvfb` on a headless machine.

The browser tests (`packages/e2e/browser/`) drive Playwright's Chromium: install it once with `pnpm exec playwright install chromium`, or point `MULTIFRONT_CHROMIUM_PATH` at another Chromium (see `.env.sample`).

The consumer tests (`packages/e2e/consumer/`) install the packed fixture library into fresh apps in the OS temp dir: they need `registry.npmjs.org` and Chromium. `MULTIFRONT_KEEP_CONSUMER_APPS=1` keeps those apps and prints their paths (see `.env.sample`). CI runs this area in its own `consumer` job, on the tarballs `pnpm devx consumer-pack` wrote once. `language-tools.spec.ts` builds and packs `@multifront/core` and `@multifront/language-tools` itself and serves them from a throwaway local verdaccio (the root `verdaccio` devDependency, on a free localhost port): the fresh app's `.npmrc` sends only `@multifront` there.

`pnpm devx peer-floor <framework>` writes the bottom of `@multifront/vite`'s peer ranges for that framework as pnpm `overrides` and reinstalls, so the `react-floor`, `vue-floor` and `svelte-floor` CI jobs run every test on the oldest supported React, Vue and Svelte. It rewrites `pnpm-workspace.yaml` and the lockfile, so it refuses to run unless `CI` is set: try it only on a throwaway checkout.

Try the extension: `pnpm devx vsix`, then `code --install-extension packages/vscode/multifront-vscode-<version>.vsix`. The command uses the `npm` CLI that ships with Node: vsce lists the plugin pack with `npm list`.

Fuzz tests run on a fixed seed. A failure prints the line that replays it; a longer run on another seed: `MULTIFRONT_FUZZ_SEED=7 MULTIFRONT_FUZZ_RUNS=10000 pnpm devx test packages/core/test/split.fuzz.spec.ts` (the scope transform's: `packages/e2e/build/scope-fuzz.spec.ts`, the Svelte scope stamping's: `packages/e2e/build/svelte-scope.fuzz.spec.ts`).

## Docs graphics

`pnpm devx docs-images` renders `docs/assets/src/*.html` with Playwright's Chromium. If that browser is not installed, point `MULTIFRONT_CHROMIUM_PATH` at another Chromium (see `.env.sample`).
