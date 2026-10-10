---
type: docs
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.1
---

# Milestone 2.1: spike, types by import attribute

## Problem

The M2 editor design rests on six open questions (milestone 2 doc, step 2.1). Steps 2.4, 2.8 and 2.9 still say "as
spike answer N says", and M3 (3.8, "Attribute rows are compared only if spike 1 kept per-import attributes") waits on
answer 1. This step answers all six with real code, writes the answers and the decision for each "no" into
`docs/plan.md` ("Prototype first", item 1), and turns every placeholder concrete. Only the docs are merged; the spike
code is thrown away.

Already seen in the sources (the spike confirms each by running it):

- `@volar/typescript` 2.4.28 `lib/node/decorateLanguageServiceHost.js`: the TS plugin path serves only
  `getServiceScript`; a plugin with `getExtraServiceScripts` gets `getExtraServiceScripts() is not available in TS
  plugin.` logged. Answer 3 is likely "no".
- TypeScript 6.0.3 `lib/typescript.js:187991` (`importServicePluginSync`) loads plugins through `host.require`, and
  `enableProxy` (`:189313`) skips a plugin whose module is not a function. An ESM `export default` gives a namespace
  object through `require(esm)`, so it would be skipped; only an ESM `'module.exports'` export or CJS would load.
- The plugin path is resolved by `tryResolveJSModuleWorker` (`:45277`) with Node10 resolution and no features:
  `package.json` `exports` are ignored, so a subpath name like `@multifront/language-tools/typescript-plugin` must exist
  as a real path in the package. That bears on answer 4 and on 2.4's `./typescript-plugin` export.

The milestone text says "five questions" but lists six: fixed here.

## Plan

### 1. Spike setup (scratch, outside the repo, never committed)

`<scratchpad>/spike1/`, its own `package.json` + `npm install`, exact pins: `typescript` 6.0.3, `@volar/typescript`
2.4.28, `@volar/language-core` 2.4.28, `@types/react` (latest, exact), `@vscode/test-electron` 3.1.0. Node 26.11.1.

- Plugin `plugin/node_modules/ucf-spike-plugin/index.cjs`: `createLanguageServicePlugin((ts, info) => ...)`.
  - Language plugin: `getLanguageId` = `ucf` for `.ucf`; `createVirtualCode` finds `<react>…</react>`, root code with
    one `react` embedded code mapped 1:1, all features on;
    `typescript.extraFileExtensions: [{extension: 'ucf', isMixedContent: true, scriptKind: Deferred}]`.
  - Script mode from the plugin config entry (`q3`): `main` = `getServiceScript` returns the react code (`.tsx`, TSX);
    `extra` = `getExtraServiceScripts` returns `{fileName: <file>.react.tsx}` instead.
  - `setup(language)` wraps `info.languageServiceHost.resolveModuleNameLiterals` (after Volar's wrapper). For each
    `.ucf` literal: find the import node (`literal.parent`, else walk `containingSourceFile` to the literal's position),
    read `framework` from `ImportDeclaration.attributes`, `ExportDeclaration.attributes` or the `import()` second
    argument, record how (`parent` / `walk`). Resolve `react` and bare to `Card.ucf` (main) or `/abs/Card.ucf.react.tsx`
    (extra); `vue` / `svelte` to on-disk stubs `Card.vue-stub.ts` / `Card.svelte-stub.ts` exporting distinct types.
  - `info.session.addProtocolHandler('_ucfSpike.resolutions', …)`: per import of a file, specifier, line, attribute
    read, how, and `program.getResolvedModule(sf, text, mode)` file name.
- Load variants for answer 4 (same factory): `esm-default` (`export default`), `esm-cjsname`
  (`export { factory as 'module.exports' }`), `@spike/tools` with only `exports: {'./typescript-plugin': …}` (plugin
  name `@spike/tools/typescript-plugin`), and the same with a real `typescript-plugin/` folder (`main` → `.cjs`).
- Apps `app-preserve/` (`jsx: react-jsx`, `module: preserve`, `moduleResolution: bundler`, `strict`) and
  `app-nodenext/` (`module: nodenext`, `"type": "module"`), each with a copy of the e2e `Card.ucf` fixture and:
  `src/App.tsx` (bare, `<Card title="x" />`), `src/main.ts` (`react`), `src/reexport.ts` (`export … from` with `vue`),
  `src/lazy.ts` (`import()` with `svelte`), `src/mixed.ts` (same specifier, `react` and `vue`).

### 2. `run.mjs`: the real tsserver over stdio (the step's test)

Spawns `node <spike>/node_modules/typescript/lib/tsserver.js --globalPlugins <name> --pluginProbeLocations
<spike>/plugin --logVerbosity verbose --logFile <tmp>`, speaks the Content-Length JSON protocol, prints a table per
question:

1. `_ucfSpike.resolutions` on `main.ts`, `reexport.ts`, `lazy.ts`: framework read per import kind, `parent` or `walk`.
2. `mixed.ts`: resolved file per literal + `quickinfo` on both bindings.
3. `q3: extra`: where `App.tsx`'s import resolves, `quickinfo` on `<Card`, `definition` on `Card` (inside
   `Card.ucf`?), the Volar warning in the log.
4. One tsserver per load variant: the load log line, and whether `quickinfo` on `<Card` works. Two more variants
   shipped: a real `typescript-plugin/` folder with an ESM `main`, and one whose `main` is `.ts` (not found: tsserver's
   lookup takes JS files only).
   4b. A real `typescript-plugin/index.js` that imports the package's own `./typescript-plugin` export (`source` and
   `default` conditions), with tsserver run plain and under `node --conditions=source`. The package is a symlink, as a
   pnpm workspace link: Node refuses to strip types under `node_modules`, and follows the link out of it.
5. `semanticDiagnosticsSync` on `main.ts`, `reexport.ts`, `lazy.ts` in both apps, every code printed. Pass = no
   diagnostic about the attribute. A control app on `module: es2020` shows TypeScript does report attributes there.
6. `q3: main`, as VS Code does: `open` `Card.ucf`; inside `<react>` `completionInfo` and `quickinfo` on `title`;
   `definition` from `App.tsx` lands in `Card.ucf`; `rename` on the prop in `Card.ucf` lists `App.tsx`; `references`
   from `App.tsx` lists the use in `<react>`; a `change` (no save) renaming the prop, then `semanticDiagnosticsSync` on
   `App.tsx` shows the old prop as an error.

### 3. VS Code run (answers 4 and 6 "inside the pinned VS Code")

VS Code 1.141.0 (latest stable today; 2.11 pins it unless a newer stable is out), `@vscode/test-electron`, under
`xvfb-run -a`, `--no-sandbox` (root host).

- `vscode/extension/package.json`: language `ucf` (`.ucf`) and
  `typescriptServerPlugins: [{name, enableForWorkspaceTypeScriptVersions: true, languages: ['ucf']}]`, plugin copied
  into `extension/node_modules/`.
- User settings: `typescript.tsdk` = the spike's TS 6.0.3 `lib`, `typescript.tsserver.log: verbose`.
- `suite.cjs` writes JSON: Electron's `process.versions.node`; plugin load lines from the tsserver log; hover and
  definition on `<Card` in `App.tsx`; hover and completion inside `<react>` of `Card.ucf`; an unsaved `WorkspaceEdit`
  renaming the prop, then `languages.getDiagnostics(App.tsx)` shows the error.
- Run with the CJS plugin, and with both ESM variants (`'module.exports'` and `export default`).
- User data lives in `/tmp/ucfs-<variant>`: VS Code's IPC socket path must stay under 107 characters. The scratch
  extension has no `activationEvents` (VS Code rejects them without a `main`).

### 4. Write the answers (as shipped)

Answers: 1 yes, 2 the expected limit (the last import wins), 3 no, 4 yes (ESM through `require(esm)`, factory exported
as `'module.exports'`, a real `typescript-plugin/` folder), 5 yes, 6 yes.

- `docs/plan.md` "Prototype first", item 1: "Answers" list (versions, one bullet per question: answer, evidence,
  decision) and "Cases 2.9 takes over".
- `docs/milestones/m2-editor-basics.md`: 2.1 "five" → "six", `- Status: done`; 2.4 exports gain the
  `typescript-plugin/` folder, the TypeScript script is the react code as main service script; 2.5 names where
  tsserver sees `Card.ucf.react.tsx`; 2.8 reads the attribute from `literal.parent` and returns the `.ucf` file itself;
  2.9 Build gets the answer 2 warning and the module format, its Test the `Card.ucf` resolution and the concrete
  `mixed.ts` case; Risks and "Hands to later milestones" (`typescript-plugin` line) follow.
- M3 "Needs" (answers 1 and 3) and 3.8's Test: imports resolve to `Card.ucf`; attribute rows compared, `mixed.ts`
  excepted.
- M4 "Needs" from M2: 4.13 must serve `Card.ucf.vue.ts` another way first.
- `docs/architecture.md` "Editor and types": one script per `.ucf` file in tsserver.
- M7 Risks (related finding, from Volar's source): `proxyCreateProgram` has no extra service scripts either, so 7.2
  cannot rely on `getExtraServiceScripts` as written.
- Not changed, since no answer was a "no" that needed them: spec §4.2, §5, §6, §11, `packages/AGENTS.md`, the
  milestones README, the graphics.

## Tests

- The test is the spike's own `run.mjs` plus the VS Code run, both on this host (Node 26.11.1, `/usr/bin/xvfb-run`,
  VS Code 1.141.0 via test-electron, download checked). Not in CI: nothing of it is merged.
- Proof: the PR description quotes the printed tables and the VS Code results JSON.
- Merged change is docs only: no Vitest test. Gate: `pnpm devx check`.

## Docs

`docs/plan.md` (Prototype first, item 1), the M2, M3, M4 and M7 milestone docs, and `docs/architecture.md` ("Editor and
types"), as in plan step 4. No publicdocs page covers the editor yet.

## Out of scope

- Any code, dependency or CI change in the repo; the 2.9 tests themselves.
- Per-target scripts another way if the answer to 3 is "no" (M4).
- Extra service scripts on the `tsc` path (`proxyCreateProgram`, M7).

## Decisions

- Spike code stays in the scratch folder; the PR description quotes its output and the `resolveModuleNameLiterals`
  wrapper (orchestrator, milestone 2.1: "the code is thrown away").
- A "no" to 5: the TypeScript plugin drops that exact TypeScript error on `.ucf` imports (built in 2.9), and spec §11
  names the setting (orchestrator: no false error in the editor, editor and `mf-tsc` agree).
- A "no" to 3 does not get an alternative spike (orchestrator: the milestone already decides, M4 solves it).

## Done when

- All six answered with run evidence in `docs/plan.md`, each "no" with its decision applied.
- No "spike answer N" placeholder left in milestone docs; 2.1 ends with `- Status: done`.
- `pnpm devx check` passes; the PR quotes the spike output; this todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own (this branch touches no source
  file, so the pass does not run).
