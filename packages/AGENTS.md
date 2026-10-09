# Packages

Rules for the JS monorepo under `packages/`. Root [AGENTS.md](../AGENTS.md) still applies.

## JS monorepo (`packages/`)

- One pnpm workspace, one `@multifront/*` namespace, one version (`version.json`) for every package.
- All `dependencies` / `devDependencies` exact-pinned. `peerDependencies` = ranges. Cross-package: `workspace:*`.
- devDependencies live at the root. ONE exception: a package carries the devDependencies satisfying its own peers
  (`@multifront/vite` carries vite, plugin-vue, vue).
- [core](core/): bundler agnostic, NEVER imports Vite or a framework plugin.
- [vite](vite/): the Vite plugin. Composes `@vitejs/plugin-vue` (peer), never forks or deep-imports it.
  Read "Building on plugin-vue" in [docs/plan.md](../docs/plan.md) first.
- **Published READMEs stay thin**: short description, repo link, status + license lines.

## TypeScript

- Per package: `tsconfig.json` (check + editor, no emit), `tsconfig.build.json` (emit, only place `dist/` appears).
- Cross-package imports resolve via the `source` export condition → nothing needs building before a check/test.
- Imports use the `.ts` extension; the build rewrites it to `.js`. ESM only.
