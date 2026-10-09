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
| Fixtures | `packages/e2e/fixtures/` | Real `.ucf` components (`components/`), and the small real apps that use them (`apps/`). Every milestone adds to them; none rewrites another's. |
| Build | `packages/e2e/build/` | Real Vite builds and dev servers of the fixture apps, with the real framework plugins. Checks the output modules, CSS and source maps. |
| Browser | `packages/e2e/browser/` | Playwright against the built or served apps: rendering, styles, HMR, hydration, visual parity across targets. |
| Editor | `packages/e2e/editor/` | The real language server over LSP, the real tsserver with our TypeScript plugin, `mf-tsc`, `mf-lint`, `mf-fmt` on the fixtures. |
| Consumer | `packages/e2e/consumer/` | The library build packed into tarballs, installed into fresh real apps (Next.js App Router, Vite React, Vite Vue, SvelteKit), built and rendered. |

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
