# Milestones

One document per milestone, each split into ordered steps. A todo is filed from one step at a time (`create-todo`), and built with `implement-todo`. The `run-milestone` skill does that for every step on its own, then checks the whole milestone and writes its public docs.

What we build: [../spec.md](../spec.md). How the pieces fit: [../architecture.md](../architecture.md). Order and packages: [../plan.md](../plan.md).

| Milestone | Document |
| --- | --- |
| 1. Splitter, block kinds + styles | [m1-splitter-block-kinds-styles.md](m1-splitter-block-kinds-styles.md) |
| 2. Editor basics | [m2-editor-basics.md](m2-editor-basics.md) |
| 3. React target and imports (go / no-go) | [m3-react-and-imports.md](m3-react-and-imports.md) |
| 4. Vue target | [m4-vue-target.md](m4-vue-target.md) |
| 5. Svelte target | [m5-svelte-target.md](m5-svelte-target.md) |
| 6. Library build | [m6-library-build.md](m6-library-build.md) |
| 6.1 Fixes and groundwork before full editor support | [m6.1-before-full-editor.md](m6.1-before-full-editor.md) |
| 7. Full editor support | [m7-full-editor-support.md](m7-full-editor-support.md) |

## Testing rules

**We test the real thing, end to end.** No unit tests of internals, no mocks, no stubs, no fake data.

- Every test feeds **real files** (real `.ucf` components, real apps) through **real tools** (real Vite, real plugin-vue / plugin-react / plugin-svelte, real TypeScript, the real language server, a real browser) and checks the real output.
- When two tools meet (our plugin and plugin-vue, a parser and a compiler), the test runs both for real. Never replace one with a fake.
- The smallest allowed test is: a real fixture file, through a public function or command, with its real output checked. That is where a package's own `test/` tests sit.
- Fuzz tests are allowed only as **generated real files**: real fixtures mutated or recombined, run through the real tools (see the fuzzy-testing skill).
- Every step ends with a test that would fail without it. Every milestone ends with an exit test that proves the milestone works as a whole.

## Test areas

The e2e tests live in one private workspace package, `packages/e2e` (never published), one folder per area. Fixtures are shared and grow with each milestone.

| Area | Folder | What it runs |
| --- | --- | --- |
| Fixtures | `packages/e2e/fixtures/` | Real `.ucf` components (`components/`), and the small real apps that use them (`apps/`). Every milestone adds to them (see "Shared names and fixtures"). |
| Build | `packages/e2e/build/` | Real Vite builds and dev servers of the fixture apps, with the real framework plugins. Checks the output modules, CSS and source maps. |
| Browser | `packages/e2e/browser/` | Playwright against the built or served apps: rendering, styles, HMR, hydration, visual parity across targets. |
| Editor | `packages/e2e/editor/` | The real language server over LSP, the real tsserver with our TypeScript plugin, `mf-tsc`, `mf-lint`, `mf-fmt` on the fixtures. |
| Consumer | `packages/e2e/consumer/` | The library build packed into tarballs, installed into fresh real apps (Next.js App Router, Vite React, Vite Vue, SvelteKit), built and rendered. |
| Devx | `packages/e2e/devx/` | The repo's dev CLI (`scripts/devx.mjs`) and its helpers on the real repo files, also on Windows. |

## Test infrastructure

Today CI is one `check` job (`pnpm devx check`), a `windows` job (Windows-only behaviour) and commitlint. Most areas need more before their tests can run there. **The step whose test first needs a piece builds it**, in the same PR, and its plan says so. A test is never skipped because the infra is missing.

| Area | First needed | What the step adds |
| --- | --- | --- |
| Build | M1 | nothing: real `vite.build()` runs inside `pnpm devx test` |
| Windows paths | M1 (1.9) | a `windows-latest` job, LF checkout (`core.autocrlf false`), running `packages/core/test/context.spec.ts` and `packages/e2e/devx/` with `pnpm devx test`; a later Windows-only behaviour adds its test file to that job |
| Fuzz | M1 (1.5) | the `MULTIFRONT_FUZZ_SEED` / `MULTIFRONT_FUZZ_RUNS` knobs, a fixed seed in CI, the seed printed on failure; later a hand-run soak workflow that takes a seed |
| Editor: tsserver, LSP, vsix | M2 | nothing: child processes and `pnpm devx vsix` inside the test |
| Editor: server to tsserver relay | M4 (4.12) | a helper in `packages/e2e/editor/lib/` that links `startLanguageServer()` to `startTsserver()`, the way the extension relays the server's tsserver requests |
| Editor: real VS Code | M2 (2.11) | the harness starts its own Xvfb on Linux with no display and gives VS Code no `NODE_OPTIONS`; a failed run keeps its Crashpad dumps in `packages/e2e/.tmp/vscode-crashes/`; the harness deletes its temp folder only once no process naming it is left (Crashpad outlives a crash); CI sets `kernel.core_pattern=/dev/null`, else a crashed VS Code hangs piping its core to systemd-coredump; CI caches the `.vscode-test/` download. M7 (7.13): the harness downloads it under a lock (`.vscode-test/download.lock`), so any spec may start VS Code, and `runInVsCode({vsix})` installs a packed `.vsix` with VS Code's own CLI into the run's fresh extensions folder |
| Fixture configs from source | M3 (3.6) | fixture apps' `vite.config.ts` load through `configLoader: 'native'` (`buildApp`), in an e2e worker run with `--conditions=source`, so `@multifront/vite` comes from `src/`, never a stale `dist/`. SvelteKit's client build reloads the config with Vite's bundling loader, which ignores `source`: its fixture imports `@multifront/vite` through a computed specifier, left to Node (M5 5.6) |
| Browser | M3 (3.9) | `pnpm exec playwright install --with-deps chromium` in CI, the browser folder cached by Playwright version |
| Oldest supported framework | M3 (3.9) | `pnpm devx peer-floor <framework>` and one CI job per framework (`react-floor` first, `vue-floor` in M4 4.7, `svelte-floor` in M5 5.3) running `pnpm devx test` on the bottom of the peer range |
| Tests from any folder | M6.1 (6.1.1) | a `check` job step after "Test", also run by `pnpm devx check`: `pnpm exec vitest run` in `packages/core`, so a test that depends on the cwd fails |
| Consumer | M6 (6.10) | a `consumer-pack` job builds and packs once (`pnpm devx consumer-pack`) and hands the tarballs to the `consumer` job (`MULTIFRONT_CONSUMER_TARBALLS`), which caches the one pnpm store the fresh apps install from and runs `packages/e2e/consumer/` with Chromium; `check` leaves that area out (`--exclude 'consumer/**'`) and the floor jobs its fresh-app specs. M7 (7.12) adds the local registry for packed packages that depend on each other: `packages/e2e/consumer/language-tools.spec.ts` builds and packs core and language-tools in a staged workspace, publishes them to a throwaway verdaccio (root devDependency, mion's pattern: `consumer/lib/registry.ts`, `consumer/lib/verdaccio.yaml`, only `@multifront/*`, no uplink) and installs from it through the fresh app's `.npmrc` |

The reference for all of it is [MionKit/mion](https://github.com/MionKit/mion)'s `.github/workflows/`: the same tooling, already solving most of this (packed tarballs through a local verdaccio registry, fuzz soak runs with a printed seed, jobs that pass artifacts). Copy its pattern before inventing one. Neither repo runs a browser or VS Code in CI yet: those two are new.

**A green check only counts if the test ran.** After adding infra, read the CI log and see the new tests execute, not skip.

## Shared names and fixtures

Decided when the seven documents were checked against each other. Where a document and this list disagree, this list wins.

- **Fixture names are unique** across `fixtures/components/`, so a name always means one file. Edge cases for one target live in that target's folder (`react/`, `vue/`, `svelte/`).
- **Shared fixtures grow a block at a time.** `Card.ucf`, `Panel.ucf` (M1), `Counter.ucf` (M3) and `imports/` (`Icon`, `UsesIcon`, `VueOnly`, `ReactOnly`) get a new target block in the milestone that adds that target. That milestone updates the snapshots the file feeds.
- **One imports fixture set:** `fixtures/apps/imports/` with `expected.ts` (M2). M3, M4 and M5 add rows and sub-projects; the build and the editor must both match every row.
- **Test helpers** live in `<area>/lib/` (`editor/lib/`, `browser/lib/`, `consumer/lib/`). Temp copies come from M1's `copyApp()`, with the shared `components/` beside the app so relative `.ucf` imports work; `removeApp()` deletes one.
- **Test tools are root devDependencies** (AGENTS.md), never `packages/e2e` ones.
- **Core names:** `BuildContext` (M1, with `split`), `buildTarget(split, ctx, target)` (M3), `resolveTarget(importer, attribute, options)` with `Importer` and `TargetChoice` (M2, extended by M3), `importerFromId(id)` (M3), `getTypesScript()` (M2), `classMapId()` / `styleId()` (M1).
- **One code per error.** `framework-in-block` (not `framework-attribute-in-block`). Codes join M1's `DiagnosticCode` union.
- **`pnpm devx vsix`** is created in M2; M7 extends it.
- **Core checks never load a compiler.** Rules that need the Vue or Svelte compiler run in `build()`.
- **Users see the word "framework".** The import attribute `with { framework }`, the plugin options `frameworks` / `framework` / `importers`, the TypeScript plugin options and the CLI flags (`--framework`). "Target" stays internal (the `Target` type, `resolveTarget`, module ids).
- **Scope forwarding is the same in every framework** (spec 3.5.1): always on, pinned by browser tests in each framework and by fuzz tests.
- **Hybrid mode from day one** (spec 6): tsserver with our plugin does every TypeScript job, inside `.ucf` files too; our language server does CSS, template HTML, our diagnostics, formatting and linting.

## Document template

Each milestone document follows this shape:

```markdown
# Milestone N: <name>

## Goal
## Needs from earlier milestones   (exact names: functions, types, files, commands)
## Steps
### N.1 <step name>
- Build: what gets written, which package, which files
- Deliverable: the concrete thing that exists when this step is done
- Test: the e2e test that proves it (area, fixture, what it checks)
### N.2 ...
## Hands to later milestones       (exact names, and which milestone uses each)
## Exit test                       (the one test that proves the milestone)
## Risks and open questions
## Out of scope
```

Steps are ordered: each one builds only on the steps before it and on the earlier milestones' hand-offs.
