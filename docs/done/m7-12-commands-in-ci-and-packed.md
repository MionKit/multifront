---
type: feature
spec: full-plan
status: ready
created: 2026-10-16
milestone: 7
step: 7.12
---

# The three commands in CI, and from the packed package

## Problem

Nothing stops a fixture from breaking one framework or getting an oxlint error, and the `mf-tsc`, `mf-lint` and
`mf-fmt` bins have only run from `src/`, never from a packed `@multifront/language-tools`. The milestone (Decision
"the commands in this repo's CI") puts `mf-tsc` and `mf-lint` over every valid fixture inside `pnpm devx test`, and
the bins into a fresh install.

A probe run (`mf-tsc -p` on a tsconfig over the fixtures) found, beside the fixtures that break on purpose:

1. **mf-tsc bug.** A `<vue>` or `<svelte>` block in JS (no `lang="ts"`) gets TS8008 / TS8009 / TS8010 / TS8016
   ("Type aliases can only be used in TypeScript files") on its opening tag: TypeScript-only syntax svelte2tsx
   (`mode: 'ts'`) and Vue's generator write into a JS-kind script, in parts with no mapping. The 7.2 rule puts
   unmapped diagnostics on the opening tag; tsserver and vue-tsc drop them. 43 errors in `NoStyle`, `svelte/shapes/*`,
   `JsDoc`, `JsNoProps`, `imports/Icon`, `GrammarEdges`, `library/src/Icon`.
2. **svelte2tsx gap.** `let props = $props()` with no annotation: svelte2tsx 0.7.61 names `$$ComponentProps` but
   declares it only for a destructured `$props()`, so TS2304 at `<svelte>` in `svelte/roots/NestedRoot`,
   `PropsOnlyRoot`, `ShadowRoot`.
3. **Fixture mistakes.** `components/Button.ucf:20` and `components/react/AllBlocks.ucf:29` use `classes.x` in
   `<svelte>` (Svelte names it `$classes`, spec 3.6); `components/react/scope/Stamped.ucf:29` `<my-el>` (React's JSX
   types do not know it; the react-scope app imports the file); `apps/attribute-canary/target.js` has no types
   (TS7016); `components/vue/GlobalProps.ucf` needs `vue/global-props.d.ts` in the program;
   `components/react/use-client/ClientHandler.ucf:3` `console.log` (`no-console`);
   `components/svelte/root-props/ReadsDestructure.ucf:10` `'style': style` (`no-useless-rename`).

## Decisions

Answers from the orchestrator, one line each:

- Packing: a staged workspace under `packages/e2e/.tmp/` for the build and `pnpm pack`, never the real `packages/*/dist` (`build/built-packages.spec.ts` must not race it).
- Core as a dependency: a local verdaccio registry, mion's pattern (pin, config, start and stop), not a pnpm `overrides` entry; the fresh app's `.npmrc` scopes only `@multifront` to it, no uplink; verdaccio a root devDependency, exact pin.
- A file is left out only when it breaks something on purpose (a spec pins the error, or its own comment says build only or deliberately broken); its exclude comment names that test or comment. Generated-types errors are our bugs (fixed here, own commit and test); plain mistakes are fixed in the fixture.
- A limit of one `mf-tsc` program that spec or architecture does not state: fixed, or a guidelines todo in this PR with the file left out for the todo's reason (the two-framework importers).
- `Merges.ucf` (svelte2tsx leaves a backtick in an attribute value unescaped): left out, plus a guidelines todo for a workaround on our side.
- Fix 1 (unmapped TypeScript-only-syntax codes dropped): yes, as tsserver and vue-tsc never show a diagnostic the user cannot map to their code; 7.2's Build sentence updated.
- The consumer spec's `mf-tsc` check with one broken block per framework: yes, the installed bin must match the source bin on the same edit.

## Plan

1. **Fix 1** (`packages/language-tools/src/tsc/program.ts:152`, `intoUcf`): an unmapped diagnostic whose code is
   in `TS_ONLY_SYNTAX` (8002, 8003, 8004, 8005, 8006, 8008, 8009, 8010, 8011, 8012, 8013, 8016, 8017, 8037,
   TypeScript's "can only be used in TypeScript files") is dropped, like `reportsUnnecessary`. A mapped one (the
   user's own syntax) is still reported. Milestone 7.2's Build sentence says so.
2. **Fix 2** (`packages/language-tools/src/blocks/svelte.ts:120`, `svelteTypes`): code that names
   `$$ComponentProps` without declaring it gets `;type $$ComponentProps = Record<string, any>;` (TS) or the JSDoc
   `@typedef` (JS) appended, svelte2tsx's own `propsStr`. Appended at the end: no mapping moves. Editor, `mf-tsc`
   and `emitSvelteTypes` all get it.
3. **Fixture fixes:** `$classes.primary` / `$classes.title` in the two `<svelte>` blocks (markup snapshots
   regenerated); `components/react/scope/custom-elements.d.ts` adds `'my-el'` to React's `JSX.IntrinsicElements`;
   `apps/attribute-canary/target.d.ts` types `target.js`; `ClientHandler.ucf` calls `window.alert`;
   `ReadsDestructure.ucf` keeps its quoted key (rootProps' `Literal` branch) as `'style': css`.
4. **`packages/e2e/fixtures/tsconfig.fixtures.json`** (JSONC): `types-every-target`'s options plus
   `allowImportingTsExtensions`, plugin entry `framework: react`; `include: ["components", "apps", "library/src"]`;
   `exclude`, each with its one-line reason naming the test or comment that shows it is on purpose: the step's
   five (`apps/types-broken`, `apps/lint-format`, `apps/lint-format-svelte`, `components/invalid`,
   `components/react/fuzz-found`); `apps/consumer-*` (templates of fresh installs); the deliberate-error files and
   folders pinned by their specs (`imports/src/bad.ts`, `BlockAttribute.ucf`, `no-default/non-literal.ts`,
   `unknown.ts`, `react-basic/src/errors`, `editor/ImportErrors.ucf`, `editor/TypeError.ucf`, `react/errors`,
   `svelte/errors`, `svelte/imports/AttrInSvelte*.ucf`, `UsesReactOnly.ucf`, `vue/AttrInside*.ucf`,
   `DuplicateVue.ucf`, `VueWithUnclosedReact.ucf`); the transform cases whose error the core specs pin or whose
   comment says so (`ArrayPattern`, `Cyclic`, `RedeclaredPattern`, `FragmentImports`, `Namespaced`,
   `ValuelessClass`, `StringHandlerRoot`); `Merges.ucf` and the two two-framework importers (todos above);
   `**/node_modules`.
5. **`packages/e2e/editor/gate.spec.ts`**, cwd `FIXTURES_DIR`. `gateUcfFiles(root)`: the `.ucf` files of
   `tsconfig.fixtures.json` (TypeScript's `getParsedCommandLineOfConfigFile`, `.ucf` as extra extension), minus
   `LINT_LEFT_OUT` (name → reason: `TsxEdges.ucf`'s `<\/react>` escape, the splitter case `core/test/split.spec.ts`
   pins; `EmptyPropsRoot.ucf`'s `let {} = $props()`, which `core/test/svelte/forward.spec.ts` pins;
   `react/errors/NoDefault.ucf`'s unused component, the missing default export `blocks/react.spec.ts` pins). The
   `react/errors` and `svelte/errors` folders are left out file by file: only those whose error a spec pins.
   - Real `mf-tsc -p tsconfig.fixtures.json --format json`: exit 0, `errorCount: 0`; on failure the message is the
     readable lines.
   - Real `mf-lint --format json <gate files>` under the repo's `.oxlintrc.json`: exit 0, `errorCount: 0`, same.
   - A copy of `fixtures/` under `.tmp/` with `components/ReactBreaks.ucf` (from `types-broken/`, plus a
     `debugger;`) and an `.oxlintrc.json` with the repo's config minus `ignorePatterns`: `mf-tsc` exits 1 with
     exactly the TS2322, `mf-lint` exits 1 with exactly the `eslint(no-debugger)`.
   - Speed: median of 5 fresh runs of `mf-tsc -p … components/Card.ucf`, `… apps/types-every-target`, the whole
     set, `mf-lint components/Card.ucf`, `mf-lint` over every gate file; one stdout line, no time assertion.
6. **Packed package** (new infra, `packages/e2e/consumer/lib/`):
   - `packLanguageTools()`: a staged workspace under `TMP_DIR` (`LICENSE`, `tsconfig.base.json`, a
     `pnpm-workspace.yaml`, copies of `packages/core` and `packages/language-tools` minus `node_modules`, `dist`,
     `test`, `*.tsbuildinfo`; each `node_modules` a folder of links to the real entries, `@multifront/core` to the
     staged core), the repo's `tsc --build` on the staged language-tools, real `pnpm pack` per package.
   - `startRegistry()`: mion's host pattern. `verdaccio@6.7.2` (root devDependency, exact pin) with a config that
     serves only `@multifront/*`, no uplink, storage in a temp folder; started detached on a free port with its
     log in a file, ready on `/-/ping`, its process group killed after. The tarballs are published with
     `npm publish --registry`, a throwaway token in a temp `--userconfig`.
   - `createConsumerApp(template, packages, {registry})` writes the app's `.npmrc`
     (`@multifront:registry=http://127.0.0.1:<port>/`) and adds `@multifront/*` to its `minimumReleaseAgeExclude`
     (just published); `runInApp(app, command, cwd)` gains `cwd` and returns `stdout` and `stderr` too.
7. **`packages/e2e/consumer/language-tools.spec.ts`**, template `fixtures/apps/consumer-language-tools/package.json`
   (typescript, oxlint, oxfmt, svelte, vue, react, @types/react at the repo's versions; `@multifront/language-tools`
   from the registry). The bins run from `node_modules/.bin` inside copies of `types-every-target/` and
   `lint-format/`:
   - `mf-tsc`: exit 0, `mf-tsc: checked 5 files with tsconfig.json: no errors`; then one wrong prop in each block of
     `Greeting.ucf`: the same output as the source bin on an in-repo copy with the same edit, exit 1.
   - `mf-lint --format json` and `mf-fmt --check --format json` in `lint-format`: exit 1, the source bin's output.
   - Each bin: `--help` exit 0, the source bin's text; `--bogus` exit 2, stdout empty, one stderr line.
8. **CI:** the floor jobs add `--exclude 'consumer/language-tools.spec.ts'`; the `consumer` job runs it.

## Tests

- Gate: `editor/gate.spec.ts`, here and CI (`check`, floor jobs). Needs nothing new.
- Consumer: `consumer/language-tools.spec.ts`, here and CI's `consumer` job (`registry.npmjs.org`, a localhost
  port). CI log lines showing it ran are quoted.
- Fix 1: `editor/tsc/every-target.spec.ts`, a `types-every-target` copy with JS `<vue>` and `<svelte>` blocks: exit
  0; `let n: number = 1` in each JS script: one TS8010 per block at `number`.
- Fix 2: same spec, a copy with a TS `<svelte>` `let props = $props()` and a `.ts` importer using
  `ComponentProps<typeof Whole>` with any prop: exit 0.
- Fixture fixes: the gate. Snapshot diffs checked.

## Docs

- Milestone doc: 7.12 `- Status: done` and a Build line on what the gate found; 7.2's rule; the "Speed." CI numbers.
- `docs/milestones/README.md` Test infrastructure "Consumer" row: the staged pack and the local registry.
- `SETUP.md`: the consumer area also packs and serves `@multifront/language-tools`.

## Fuzzing

None: the gate runs fixed fixtures.

## Out of scope

- `.svelte` importers in `mf-tsc`.

## Done when

- `pnpm devx check` green; CI `check` runs the gate and `consumer` runs the new spec, seen executing in the logs.
- The CI speed numbers are in the milestone doc; this todo is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
