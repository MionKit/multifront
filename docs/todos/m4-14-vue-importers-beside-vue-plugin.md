---
type: feature
spec: full-plan
status: ready
created: 2026-10-11
milestone: 4
step: 4.14
---

# Milestone 4.14: `.vue` importers beside Vue's TypeScript plugin

## Problem

In VS Code, Vue - Official and our extension each contribute a tsserver plugin; both decorate the same project host,
and `App.vue`'s imports go through the host's `resolveModuleNameLiterals`. A spike on
`fixtures/apps/vue/src/App.vue` with real `@vue/typescript-plugin` 3.3.11 and our packed `.vsix` plugin:

- **Vue's plugin first, ours second:** works. `<Counter :start="'x'" />` is one `TS2322` at `start`, `Counter` is a
  `DefineComponent`, definition on `:start` lands on `start?: number` inside `Counter.ucf`'s `<vue>` block.
- **Ours first, Vue's second: broken.** Every `.ucf` import is `TS2307`. Our resolver wrapper
  (`packages/language-tools/src/typescriptPlugin.ts:141-152`) is installed at our `create`, so Vue's Volar copy wraps
  it later. Volar's wrapper (`@volar/typescript/lib/node/decorateLanguageServiceHost.js`) resolves the whole batch
  itself as soon as one literal ends in `.vue` (`./Plain.vue`), never calling ours.
- **One shared `@volar/typescript` copy (a project listing `@multifront/language-tools/typescript-plugin` and
  `@vue/typescript-plugin` in `compilerOptions.plugins` from one install, as other editors do, or VS Code with the
  project's own entry): broken in either order.** `createLanguageServicePlugin`
  (`@volar/typescript/lib/quickstart/createLanguageServicePlugin.js`) skips a host already in the module-level
  `decoratedLanguageServiceHosts` WeakSet, so the second plugin never decorates. Ours second: `.ucf` imports
  `TS2307`. Vue's second: `App.vue` read as plain TypeScript. Its `projectExternalFileExtensions` / `externalFiles`
  WeakMaps are shared the same way.
- `apps/vue` has no `tsconfig.json`; the `with { framework: 'vue' }` import in `App.vue` (4.10) needs `module: preserve`
  or TypeScript reports `TS2823`.
- `editor/imports.spec.ts:11-12` skips the `src/Page.vue` row ("before 4.14").
- `packages/vscode/README.md` does not exist.

## Decisions

- Orchestrator: plan approved.
- Q1, orchestrator: the shared-copy setup must work (milestone Risks and the tsconfig case of the Test line). Our
  plugin keeps its own decoration record (step 2) plus the outermost resolver (step 1); no bundled npm entry. Risks
  names that `languageServicePlugin.ts` mirrors Volar's quickstart internals, so a Volar bump breaks it first.
- Q2, orchestrator: definition on `<Counter` lands at `Counter.ucf` 1:1 (as Volar does for `Plain.vue`, and 4.13 for
  `.ts` importers), on `:start` at `start?: number` inside the `<vue>` block. The 4.14 Test line changes.
- No fuzz test: no cheap oracle.

## Plan

### 1. `.ucf` resolution stays outermost (`packages/language-tools/src/typescriptPlugin.ts`)

- Today's wrapper body (lines 143-151) becomes `wrapResolve(resolve)`: handles `.ucf` literals, passes the rest to
  `resolve`.
- In `setup()`, instead of a plain assignment, an accessor on the host:
  `get: () => current`, `set: (next) => { current = wrapResolve(next); }`, with `current = wrapResolve(bound original)`.
  A plugin wrapping the host after ours reads our layer as its inner, and its new value gets our layer on top again:
  the outermost copy sees every `.ucf` literal, inner copies see none. TypeScript reads the property at each program
  build, so ours runs first in either load order.

### 2. Our own decoration record (`packages/language-tools/src/languageServicePlugin.ts`, new)

- `createLanguageServicePlugin(callback)`, our version of Volar's quickstart, same callback, returns
  `{create, getExternalFiles}`.
- `create(info)`: if this plugin already decorated `info.languageServiceHost` (a WeakSet in this module: a tsconfig
  reload stays a no-op), return `info.languageService`. Else run the callback, Volar's `createProxyLanguageService`
  (`lib/node/proxyLanguageService.js`) and `createLanguageCommon` (`lib/quickstart/languageServicePluginCommon.js`),
  exactly as Volar's `create` does, but never reading or writing Volar's shared WeakSets / WeakMaps.
- `getExternalFiles(project, updateLevel)`: our extension list per project, `searchExternalFiles`
  (`lib/node/decorateLanguageServiceHost.js`), cached per project, `project.refreshDiagnostics()` when the list
  changes, as Volar's `makeGetExternalFiles`.
- `typescriptPlugin.ts:3` imports it instead of Volar's. The "first copy serves" check (`SERVED`) is unchanged.

### 3. Fixtures

- `packages/e2e/fixtures/apps/vue/tsconfig.json` (new): `target es2022`, `module preserve` (comment: App.vue's
  `with { framework }` import, else TS2823), `moduleResolution bundler`, `strict`, `noEmit`, `skipLibCheck`,
  `include: ["src"]`. No `plugins`: the VS Code setups load them globally.

### 4. Test helpers (`packages/e2e/editor/lib/tsserver.ts`)

- `startTsserver` passes `--pluginProbeLocations` even with no global plugins (line 77), so `compilerOptions.plugins`
  entries resolve from them.
- New exports `VUE_PLUGIN = '@vue/typescript-plugin'` and `VUE_PLUGIN_DIR`: its install folder, three levels above the
  real path of its `package.json` (the folder whose `node_modules` holds it and its own dependencies). Those tsservers
  run non-isolated: with `--preserve-symlinks` Vue's plugin cannot find `@volar/source-map`.

### 5. `packages/vscode/README.md` (new, thin)

- What it is; "`.vue` files importing a `.ucf` component get its Vue type through Vue - Official (`Vue.volar`), which
  must be installed too"; repo link; status; license.

### 6. Dependency

- `@vue/typescript-plugin` 3.3.11 as a root devDependency (exact), the version language-tools pins.

## Tests

All in `pnpm devx test`, on this host and in CI's `check`, `react-floor` and `vue-floor` jobs. No new CI job; the
only new infra is the root devDependency.

`packages/e2e/editor/vue-importer.spec.ts` (new), one `packVsix()` in `beforeAll` as `bundle.spec.ts` does,
`describe.each` over four setups:

1. VS Code way, Vue's plugin first: `--globalPlugins @vue/typescript-plugin,multifront-typescript-plugin-pack`,
   probes `[VUE_PLUGIN_DIR, extension]`, on the fixture app.
2. VS Code way, ours first: same, reversed.
3. and 4. tsconfig way, both orders: a `copyApp('vue')` copy whose `tsconfig.json` lists `@vue/typescript-plugin` and
   `@multifront/language-tools/typescript-plugin` (the project's own install, from source) in `compilerOptions.plugins`;
   probes `[VUE_PLUGIN_DIR, E2E_DIR]`, no global plugins. A first check asserts both resolve the same real
   `@volar/typescript` folder, so this stays the shared-copy case.

Each opens `App.vue`:

- the tsserver log shows each plugin loaded from its own folder (VS Code setups);
- `App.vue` as written: no diagnostic (every `.ucf` import resolves, no TS2823);
- an unsaved `<Counter :start="'x'" />`: exactly one `TS2322`, from `start` to its end;
- quick info on `<Counter` matches `/^\(property\) Counter: DefineComponent</`;
- definition on `<Counter` is `Counter.ucf` at 1:1 (as Volar gives `Plain.vue` at 1:1);
- definition on `:start` is `locate(Counter.source, 'start?: number')`, inside the `<vue>` block (`inBlock`);
- the plain `.vue` import keeps working: definition on `<Plain` is `Plain.vue`.

Setups 2 and 4 fail without step 1; 3 and 4 without step 2.

`editor/imports.spec.ts`: the tsserver also loads `@vue/typescript-plugin` (probes `[E2E_DIR, VUE_PLUGIN_DIR]`); the
`.vue` filter goes, so `src/Page.vue` line 2 runs: no diagnostic, definition on `Card.ucf`. The project's own entry
and a global Vue plugin on one shared Volar copy: fails without step 2.

`editor/vsix.spec.ts`: the exact packed list gains `README.md` (vsce packs it), still no vsce warning.

## Docs

- `docs/milestones/m4-vue-target.md`, 4.14: Build ("What to fix" → what shipped), Test line (setups, the `<Counter`
  / `:start` definition split, the `imports.spec.ts` `.vue` row), Risks ("Two Volar TypeScript plugins" settled, and
  `languageServicePlugin.ts` mirrors Volar's quickstart internals), Hands (outermost resolver and own decoration
  record, for M6's `typescript-svelte-plugin` beside ours), `- Status: done`.
- `docs/architecture.md`, "Editor and types", "Importing a `.ucf` file": one sentence on coexisting with another
  plugin on the same host.
- `docs/spec.md` section 11, risk "Our TypeScript plugin inside other editors' setups": settled for Vue.

## Fuzzing

None: no cheap oracle.

## Out of scope

- `mf-tsc` / `vue-tsc` on `.vue` importers (M7). Svelte's plugin (M6).
- Making `<Counter` land inside the `<vue>` block instead of the file start.

## Done when

- `Counter` in `App.vue` has its Vue type with Vue's plugin and ours in either order, globally and through tsconfig
  `plugins` with one shared `@volar/typescript`.
- Every test above passes; `pnpm devx check` is green. Docs updated; 4.14 ends with `- Status: done`.
- This todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
