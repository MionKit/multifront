# Milestones

One document per milestone, each split into ordered steps. A todo is filed from one step at a time (`create-todo`), and built with `implement-todo`.

What we build: [../spec.md](../spec.md). How the pieces fit: [../architecture.md](../architecture.md). Order and packages: [../plan.md](../plan.md).

| Milestone | Document |
| --- | --- |
| 1. Splitter, block kinds + styles | [m1-splitter-block-kinds-styles.md](m1-splitter-block-kinds-styles.md) |
| 2. Editor basics | [m2-editor-basics.md](m2-editor-basics.md) |
| 3. React target and imports (go / no-go) | [m3-react-and-imports.md](m3-react-and-imports.md) |
| 4. Vue target | [m4-vue-target.md](m4-vue-target.md) |
| 5. Library build | [m5-library-build.md](m5-library-build.md) |
| 6. Svelte target | [m6-svelte-target.md](m6-svelte-target.md) |
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

## Shared names and fixtures

Decided when the seven documents were checked against each other. Where a document and this list disagree, this list wins.

- **Fixture names are unique** across `fixtures/components/`, so a name always means one file. Edge cases for one target live in that target's folder (`react/`, `vue/`, `svelte/`).
- **Shared fixtures grow a block at a time.** `Card.ucf`, `Panel.ucf` (M1), `Counter.ucf` (M3) and `imports/` (`Icon`, `UsesIcon`, `VueOnly`, `ReactOnly`) get a new target block in the milestone that adds that target. That milestone updates the snapshots the file feeds.
- **One imports fixture set:** `fixtures/apps/imports/` with `expected.ts` (M2). M3, M4 and M6 add rows and sub-projects; the build and the editor must both match every row.
- **Test helpers** live in `<area>/lib/` (`editor/lib/`, `browser/lib/`, `consumer/lib/`). Temp copies come from M1's `copyApp()`.
- **Test tools are root devDependencies** (AGENTS.md), never `packages/e2e` ones.
- **Core names:** `BuildContext` (M1, with `split`), `buildTarget(split, ctx, target)` (M3), `resolveTarget(importer, attribute, options)` with `Importer` and `TargetChoice` (M2, extended by M3), `importerFromId(id)` (M3), `getTypesScript()` (M2), `classMapId()` / `styleId()` (M1).
- **One code per error.** `framework-in-block` (not `framework-attribute-in-block`). Codes join M1's `DiagnosticCode` union.
- **`pnpm devx vsix`** is created in M2; M7 extends it.
- **Core checks never load a compiler.** Rules that need the Vue or Svelte compiler run in `build()`.

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
