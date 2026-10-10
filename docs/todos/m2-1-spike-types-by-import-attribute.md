---
type: docs
spec: full-plan
status: ready
created: 2026-10-10
milestone: 2
step: 2.1
---

# Milestone 2.1: spike, types by import attribute

## Problem

The M2 editor design rests on six open questions (milestone 2 doc, step 2.1). Steps 2.4, 2.8 and 2.9 still say "as
spike answer N says", and M3 (3.10, "Attribute rows are compared only if spike 1 kept per-import attributes") waits on
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
4. One tsserver per load variant: the load log line, and whether `quickinfo` on `<Card` works.
5. `semanticDiagnosticsSync` on `main.ts`, `reexport.ts`, `lazy.ts` in both apps, every code printed. Pass = no
   diagnostic about the attribute.
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
- Run with the CJS plugin, and with each ESM variant that loaded under Node 26.

### 4. Write the answers

- `docs/plan.md` "Prototype first", item 1: "Answers" list (TypeScript 6.0.3, Volar 2.4.28, Node 26.11.1, VS Code
  1.141.0 + Electron's Node), one bullet per question: yes/no, one line of evidence, the decision (from the milestone
  text for 1, 2, 3, 4, 6; from Decisions below for 5). Then "Cases 2.9 takes over": the run.mjs cases.
- `docs/milestones/m2-editor-basics.md`: 2.1 "five" → "six", `- Status: done` last; placeholders made concrete in 2.4
  ("the one spike answer 3 picked"), 2.8 ("(spike answer 1)"), 2.9 ("the warnings of 2.1, if a spike answer was
  "no"", "Module format as spike answer 4 says", "behaves as spike answer 2 decided"); 2.4's `./typescript-plugin`
  export reshaped if tsserver cannot find it through `exports`; "Hands to later milestones" where a name or shape
  changes.
- Answer-dependent edits:
  - No to 1: spec §5 "Attribute-aware resolution" and §4.2 attribute rows "build only (types follow the importer)";
    2.7 `expected.ts` attribute rows "build only"; M3 3.10's conditional made concrete. Yes: only that M3 sentence.
  - Limit on 2: the 2.9 `mixed.ts` case names the warning and the fix (one re-export file per framework).
  - No to 3: 2.4, 2.5, 2.8 say the react code is the `.ucf` file's main service script, importers resolve to
    `/abs/Card.ucf`; spec §5 and architecture "Editor and types" say so for M2; M4 4.13 gets a "Needs" line (solve
    per-target scripts before Vue). `docs/assets/src/language.html` / `grid.html` only if what they show turns wrong,
    then `pnpm devx docs-images`.
  - No to 4: 2.4 / 2.9 say `./typescript-plugin` ships one bundled `.cjs`; `packages/AGENTS.md` "ESM only" names it.
  - No to 5: plan.md answer 5, the 2.9 Build line (`getSemanticDiagnostics` drops that exact TypeScript error on
    `.ucf` imports), spec §11 "Tools without our plugin" names the setting; later docs (M7 `mf-tsc`) if a handed-on name
    or shape changes.
  - No to 6: spec §6, architecture "Editor and types", milestones README "Hybrid mode" and the M2 goal take the
    two-program fallback and its limits; M4 gets the re-check.

## Tests

- The test is the spike's own `run.mjs` plus the VS Code run, both on this host (Node 26.11.1, `/usr/bin/xvfb-run`,
  VS Code 1.141.0 via test-electron, download checked). Not in CI: nothing of it is merged.
- Proof: the PR description quotes the printed tables and the VS Code results JSON.
- Merged change is docs only: no Vitest test. Gate: `pnpm devx check`.

## Docs

`docs/plan.md` (Prototype first, item 1) and the M2 milestone doc always; the rest per answer, as in plan step 4. No
publicdocs page covers the editor yet.

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
