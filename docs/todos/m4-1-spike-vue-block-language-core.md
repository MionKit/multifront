---
type: docs
spec: full-plan
status: ready
created: 2026-10-11
milestone: 4
step: 4.1
---

# Milestone 4.1: spike 2, a `<vue>` block through `@vue/language-core`

## Problem

Steps 4.3, 4.12 and 4.13 build the `<vue>` editor half "from the spike's chosen path", and the milestone's "If it
fails" list rewrites them by the answers. This step answers the four questions of 4.1 with real code on a real `.ucf`
fixture, writes the answers and the chosen path into `docs/plan.md` ("Prototype first", item 2), and makes every
dependent step text concrete. Only docs are merged; the spike code is thrown away.

Versions: the newest releases past the 30 day age cutoff (2026-09-11), all on our `@volar/*` 2.4.28:
`@vue/language-core` 3.3.11 (2026-08-21, depends on `@volar/language-core` 2.4.28 exactly), `@vue/language-service`
3.3.11 (`@volar/language-service` 2.4.28, `volar-service-*` 0.0.71, same as our `volar-service-css`),
`@vue/typescript-plugin` 3.3.11 (`@volar/typescript` 2.4.28). 3.3.12 and 3.3.13 are too young.

Already seen in the 3.3.11 sources (the spike confirms each by running it):

- `createVueLanguagePlugin(ts, compilerOptions, vueCompilerOptions, asFileName)` (`lib/languagePlugin.js`).
  `createVirtualCode` accepts languageId `vue` only (`file-vue` `isValidFile`), returns a `VueVirtualCode` with
  `id: 'main'`, mappings = one identity span over its whole snapshot with `codeFeatures.full`. Its embedded codes map
  to `block.startTagEnd` offsets of the text it parsed (`virtualCode/embeddedCodes.js`). So with same-length SFC code
  every mapping is already in `.ucf` offsets.
- Volar maps every embedded code against the source script, not its parent code: nesting adds no shift.
- Question 3 risk: `@vue/language-service`'s `resolveEmbeddedCode` returns `root: sourceScript.generated.root`, and its
  plugins read `info.root.ir`, `info.root.fileName`, `info.root.vueCompilerOptions` (`vue-template` completion reads
  `info.root.ir.template`); three places test `root instanceof VueVirtualCode`. On the tsserver side
  `@vue/typescript-plugin`'s `getProjectAndVirtualCode` checks the same `instanceof`; its request functions
  (`getComponentNames(ts, program, virtualCode)` …) take the code directly.
- Id clash risk: the same-length SFC code keeps the root `<style>` blocks, so Vue also emits `style_0`, `style_1` codes,
  the ids our root already uses for the same blocks.
- Question 4: the generated `script_ts` starts with `/// <reference types="<typesRoot>/template-helpers.d.ts" />` (plus
  `props-fallback.d.ts` when `checkUnknownProps` is off). `typesRoot` defaults to `join(__dirname, '..', 'types')`, the
  `types/` folder shipped inside `@vue/language-core`. The helpers import nothing; the generated code imports `vue`
  from the `.ucf` file's own location. In a bundle (`scripts/lib/bundle-vscode.mjs` puts the TypeScript plugin into
  `packages/vscode/dist/typescript-plugin.cjs`) `__dirname` is `dist/`, so the default points nowhere.

## Plan

### 1. Spike setup (scratch, outside the repo, never committed)

Like spikes 1 and 3: a scratch folder, not a scratch branch, so the PR diff stays docs only.

`<scratchpad>/spike2/`, own `package.json` + `npm install --ignore-scripts` (no workspace lockfile change). Exact pins:
`@vue/language-core`, `@vue/language-service`, `@vue/typescript-plugin` 3.3.11; `@volar/language-core`,
`@volar/language-service`, `@volar/typescript` 2.4.28; `typescript` 6.0.3; `vue` 3.5.42; `vite` 8.2.2 (bundle check);
`vscode-uri` 3.2.0. Node 26.11.1.

- `fixtures/`: `Card.ucf` (the e2e fixture, unchanged: `{{ title }}`, `:class="$style.card"`); `Counter.ucf` (the e2e
  fixture with its `<vue>` block filled as 4.2 will: `<script setup lang="ts">` with `defineProps<{start?: number}>()`
  and `const count = ref(props.start ?? 0)`, a template with `{{ count }}`, `:class="$style.button"` and a non-ASCII
  label); `CounterCrlf.ucf` (CRLF copy); `CounterError.ucf` (`{{ count.toFixed('x') }}`); `tsconfig.json` (`strict`,
  `module: preserve`, `moduleResolution: bundler`).
- `sfc.mjs`: the same-length SFC code by hand. Block ranges from `splitBlocks` of the repo's `@multifront/core` source
  (`node --conditions=source`); blanks by UTF-16 code unit: `<vue>` / `</vue>` to spaces, every other target block to
  spaces with `\r` and `\n` kept, root `<style>` blocks unchanged. Asserts `code.length === source.length` and same
  line-break offsets.
- `plugin/`: a scratch Volar language plugin for `.ucf`, two root modes from the plugin config:
  - both: root code (`id: 'root'`, `languageId: 'ucf'`, identity mapping) with embedded codes `react` (as M2) and the
    `createVueLanguagePlugin(...).createVirtualCode(fileName, 'vue', sfcSnapshot)` result, given the id `vue`;
  - `nested`: that root as is (the milestone's shape);
  - `forward`: the same root plus `fileName`, `ir`, `vueSfc`, `vueCompilerOptions` getters reading the nested code.
  - It is also a tsserver plugin (`createLanguageServicePlugin`): `getServiceScript` returns the nested `script_ts`.
    The spike needs one service script; serving React and Vue side by side stays 4.13's job.
  - Protocol handlers `_ucfSpike.getComponentNames`, `getElementNames`, `getComponentProps`, `getElementAttrs`,
    `getComponentDirectives`: find the nested `VueVirtualCode` and call `@vue/typescript-plugin`'s request functions
    with it (the hybrid-mode client Vue's own server uses).

### 2. `run.mjs`: the spike's test (asserts, prints one table per question)

A real tsserver over stdio, as spike 1's `run.mjs` (`--globalPlugins`, `--pluginProbeLocations`, verbose log).

1. **Codes build?** Per fixture: embedded code tree (id, languageId, length, nesting), no exception, `vueSfc.errors`
   empty. tsserver `syntacticDiagnosticsSync` + `semanticDiagnosticsSync`: 0 on `Card.ucf`, `Counter.ucf`,
   `CounterCrlf.ucf`; `CounterError.ucf` exactly one error at the `.ucf` range of `'x'` (4.3's test case).
2. **Mappings with no shift?** Three spots in `Counter.ucf` and `CounterCrlf.ucf`: `count` in `{{ count }}` (template
   expression), the `count` declaration in `<script setup>` (script variable), `button` in `$style.button`; `Card.ucf`
   adds `title` and `$style.card`. Per spot: `language.maps.get(scriptTs, sourceScript).toGeneratedLocation(offset)`
   lands where the generated text is the same identifier, and `toSourceLocation` returns the same `.ucf` offset.
   Asserted. tsserver `quickinfo` at each `.ucf` line/column shows the type; `definition` from `{{ count }}` lands on
   its declaration in `Counter.ucf`.
3. **Vue's services nested?** In-process `@volar/language-service` `createLanguageService` with the scratch language
   plugin and `createVueLanguageServicePlugins(ts, client)`, `client` forwarding to the tsserver handlers above; once
   per root mode (`nested`, `forward`). In `Counter.ucf`'s template: completions offer a tag (`<di` → `div`), an
   attribute (`<div cl` → `class`), a directive (`<div v-` → `v-if`). Record every thrown error and its plugin. Also
   record duplicate embedded code ids (Vue's `style_N` vs ours) and which ranges the `vue`-language code claims through
   its full-file mapping.
4. **Global types?** tsserver's program file list for `Counter.ucf`: paths of `template-helpers.d.ts` and
   `props-fallback.d.ts`, any diagnostic naming `__VLS_*`. Then the scratch plugin bundled into one CJS with Vite (as
   `scripts/lib/bundle-vscode.mjs` does), loaded from another folder, same check; if the reference breaks, `typesRoot`
   set to a `types/` copy beside the bundle, check again.

### 3. Write the answers (in the repo)

- `docs/plan.md` "Prototype first", item 2: "Answers" (versions, one bullet per question: answer, evidence, decision;
  both root modes and which won) and "Cases later steps take over" (what 4.3, 4.12, 4.13 must test).
- `docs/milestones/m4-vue-target.md`: 4.1 ends with `- Status: done`; "New dependencies" gets the exact versions the
  spike ran (`@vue/language-core` 3.3.11, `@vue/typescript-plugin` 3.3.11, `@vue/language-service` 3.3.11 if question 3
  needs it in our server); each "yes" makes 4.3, 4.12, 4.13 concrete (root shape, `vue` code id, the `style_N` clash,
  the `vue` code's mapping range, `typesRoot` and bundle wiring); each "no" applies its listed "If it fails" change to
  4.3, 4.12, 4.13, "Hands to later milestones", Risks, and `docs/milestones/m7-full-editor-support.md` for anything
  moved to M7.
- `docs/spec.md` §11 first risk ("A `<vue>` block inside another file"): replaced by the answer; questions 1 or 2
  failing change §5 and §11 as the milestone says.
- `docs/architecture.md` "Editor and types": one line on how the `<vue>` block is served, only if the chosen path
  changes it. Graphics re-rendered only if one becomes wrong.

## Tests

- The spike's `run.mjs` is the test: it asserts the round-trip offsets (question 2), the diagnostic counts (question
  1), the same-length invariant and the completion results it records. Runs on this host only (Node 26.11.1, tsserver
  over stdio, no display). Not in CI: none of it is merged.
- Proof: the PR description quotes the printed tables.
- Merged change is docs only: no Vitest test. Gate: `pnpm devx check`.

## Docs

As in plan step 3. No publicdocs page covers the editor's `<vue>` block yet.

## Fuzzing

None: the code is thrown away; the same-length invariant gets its real tests in 4.2.

## Out of scope

- Any code, dependency, fixture or CI change in the repo (fixture `<vue>` blocks are filled in 4.2).
- Serving the React and Vue scripts of one `.ucf` side by side in tsserver (4.13).
- `vueSfcCode()` itself (4.2) and the real language server wiring (4.12).

## Decisions

- Question 3 tries both root modes, `nested` and `forward` (orchestrator: same question, the code stays nested; if
  `forward` works, Vue tag and directive completions stay in M4).
- No fuzz test (orchestrator: code thrown away, 4.2 tests the same-length invariant).
- Scratch folder instead of a scratch branch (orchestrator: the point is "not merged").

## Done when

- All four answered with run evidence in `docs/plan.md` item 2, with the chosen path; each "no" with its change applied.
- No "from the spike" / "per the 4.1 outcome" placeholder left in 4.3, 4.12, 4.13; 4.1 ends with `- Status: done`.
- `pnpm devx check` passes; the PR quotes the spike output; this todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file (this branch touches none, so it does not run).
