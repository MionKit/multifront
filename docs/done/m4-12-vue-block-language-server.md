---
type: feature
spec: full-plan
status: done
created: 2026-10-11
milestone: 4
step: 4.12
---

# Milestone 4.12: the `<vue>` block in the language server

## Problem

Since 4.3, tsserver serves the `<vue>` block's TypeScript (`Card.ucf.vue.ts` beside the React script,
`targetScripts.ts`). Our language server (`packages/language-tools/src/server.ts:42`) runs only `volar-service-css` and
`multifrontService`. So no Vue template service runs: no tag, attribute or directive completion, and no template
compiler error.

Spike 2 (`docs/plan.md` "Prototype first", item 2, answer 3) showed two things:

- Vue's service plugins work on our nested `VueVirtualCode` only when the root code forwards `fileName`, `ir`,
  `vueSfc` and `vueCompilerOptions` to it.
- They need a `client` that asks tsserver for types.

Today none of that exists:

- The root (`languagePlugin.ts:42` `createRootCode`) has no such getters.
- Nothing relays server requests to tsserver.
- The TypeScript plugin has no handler to answer them.

The in-block import rule also misses `<vue>`:

- `resolveUcfImport` (`resolve.ts:79`) gives a block importer only to a `.ucf` containing file (the React script).
- The Vue script `UsesIcon.ucf.vue.ts` counts as a plain `.ts` importer. So `import Icon from './Icon.ucf'` in
  `<vue>` gets `no-target` (`.ts` has no default framework).
- `with { framework }` inside `<vue>` gives no `framework-in-block` error.
- A vue pick never resolves (`resolve.ts:105`, `target-not-built`).

Read during planning (`@vue/language-service`, `@vue/typescript-plugin`, `@vue/language-server` 3.3.11 from npm):

- **Vue's plugins.** `createVueLanguageServicePlugins(ts, client)` returns 25 plugins.
  - Vue's `css` plugin is `volar-service-css` re-wrapped, with `name: 'css'`, the same name as ours.
  - Every plugin reads `info.root` only after checking the code id (`template`, `script_*`, `scriptsetup_raw`,
    `root_tags`). Files without a `<vue>` block are untouched.
  - Three plugins wait for code id `main` (Vue's root id): `vue-inlayhints`, `vue-document-highlights`,
    `typescript-semantic-tokens`. Our root is `root` and the nested code is `vue`, so those three stay idle.
    tsserver serves highlights in hybrid mode.
- **Client methods.**
  - The template plugin calls `getComponentNames`, `getElementNames` (tags), `getElementAttrs`, `getComponentProps`
    and `getComponentDirectives` (attributes). Each takes the root's `fileName` first.
  - On a no-op client (Vue's own default), the other methods return nothing.
- **How Vue relays.** Vue's server sends the LSP notification `tsserver/request` `[id, command, args]` and waits for
  `tsserver/response` `[id, body]`. Its extension runs `typescript.tsserverRequest` (`isAsync`, `lowPriority`) and
  answers `res?.body`. VS Code's `typescript.tsserverRequest` allows commands that start with `_`.
- **Vue's request functions** in `@vue/typescript-plugin/lib/requests/`:
  - They read `program.getSourceFile(fileName)` (the `.ucf` name) and `getSelfComponentName(fileName)` (the file's
    own component, `Counter`).
  - `getComponentProps` maps a template offset through
    `sourceScript.generated.languagePlugin.typescript.getServiceScript(code)` and `language.maps`, then asks
    `tsLanguageService.getCompletionsAtPosition(code.fileName, …)`.
- **Logging.** `vscode-languageserver` turns the server's `console.warn` into `window/logMessage`. Volar logs every
  plugin throw with `console.warn` (`featureWorkers.js`, `safeCall`). `@volar/test-utils` prints log messages but
  keeps none.

## Decisions

- Orchestrator: plan approved.
- Q1, orchestrator: two checks join the real VS Code suite (the relay is new behaviour; the harness exists).
- Q2, orchestrator: `defineProps<{size?: number}>()` in `Icon.ucf`'s `<vue>` block only; the template-only core row
  moves to `imports/VueOnly.ucf`.
- Q3, orchestrator: only the five requests the step names; the rest are no-ops, as in Vue's default client.
- Q4, orchestrator: `.ts` importers keep `target-not-built` until 4.13; only in-block imports resolve here.
- No fuzz test.

## Plan

### 1. Dependencies (`packages/language-tools/package.json`)

- `@vue/language-service` 3.3.11 and `@vue/typescript-plugin` 3.3.11, exact dependencies.
- Both use `@volar/*` 2.4.28 and `volar-service-*` 0.0.71, the versions we already pin. Lockfile updated.

### 2. The forwarding root (`src/blocks/vue.ts`, `src/languagePlugin.ts`, `src/types.ts`)

- `blocks/vue.ts` exports `forwardToVueCode(root, code)`: getters `fileName`, `ir`, `vueSfc` and
  `vueCompilerOptions` on `root`, each reading `code`.
- `createRootCode` calls it when an embedded code has id `vue`.
- `UcfVirtualCode` gains `Partial<Pick<VueVirtualCode, 'fileName' | 'ir' | 'vueSfc' | 'vueCompilerOptions'>>`.

### 3. In-block import rule for `<vue>` (`src/resolve.ts`, `src/targetScripts.ts`)

- **Importer.** A `.ucf` containing file stays `{block: MAIN_SCRIPT_TARGET}`. Any other name goes through core's
  `importerFromId()`, which reads `X.ucf.vue.ts` as `{fileName: X.ucf, block: 'vue'}`. So `with { framework }` inside
  `<vue>` gives `framework-in-block` at the specifier, as in `<react>`.
- **Resolution.** A vue pick from a `<vue>`-block importer, to a file with a `<vue>` block, resolves to
  `targetScriptName(fileName, 'vue')` (`Icon.ucf.vue.ts`, `extension: ts.Extension.Ts`). No `<vue>` block:
  `missing-target-block`, unresolved. Every other vue pick keeps `target-not-built` (4.13).
- `targetScriptName` is exported from `targetScripts.ts`.

### 4. tsserver answers Vue's requests (new `src/vueRequests.ts`, `src/typescriptPlugin.ts`)

- `VUE_REQUESTS` (the five names) and `vueRequestCommand(name)` = `_multifront:<name>`.
- `serveVueRequests(ts, info, language, base)`, from the plugin's `setup`: stores an answer function on
  `info.project` under `Symbol.for('multifront.vue-requests')`, and registers one `info.session.addProtocolHandler`
  per request, once per session. A handler takes `[fileName, ...rest]`, finds the project with
  `projectService.getDefaultProjectForFile(toNormalizedPath(fileName), false)` and returns
  `{response, responseRequired: true}`.
- The answer, only for a `.ucf` file whose root has a `vue` code and whose program holds `Card.ucf.vue.ts`:
  - the program is wrapped so `getSourceFile(Card.ucf)` returns `Card.ucf.vue.ts`;
  - `getComponentNames(ts, program, vueCode)`; `getElementNames`, `getElementAttrs`, `getComponentDirectives` with
    `fileName`;
  - `getComponentProps(ts, base, program, language, sourceScript, {fileName: 'Card.ucf.vue.ts', ir}, position)`,
    with a stand-in `languagePlugin` on the `.ucf` script whose `getServiceScript` returns the Vue `script_ts` code
    with `preventLeadingOffset`.

### 5. The language server runs Vue's plugins (`src/server.ts`)

- With a TypeScript from the tsdk: `[createCssService(), multifrontService,
  ...createVueLanguageServicePlugins(ts, client).filter(({name}) => name !== 'css')]`. No tsdk: no Vue plugins.
- `client`: the five requests send `tsserver/request` `[id, vueRequestCommand(name), args]` and resolve on
  `tsserver/response` `[id, body]`; every other method is a no-op returning `undefined`.

### 6. The extension relays (`packages/vscode/src/extension.ts`)

`tsserver/request` → `typescript.tsserverRequest` (`isAsync`, `lowPriority`) → `tsserver/response`
`[id, result?.body]`. A failed command still answers, with `undefined`.

### 7. Test infrastructure: the relay helper (`packages/e2e/editor/lib/lsp.ts`)

- `relayTsserver(server, tsserver)`: answers `tsserver/request` with `tsserver.request(command, args)`'s body,
  `undefined` on a failed request.
- `startLanguageServer()`'s handle gains `log: {type, message}[]`, every `window/logMessage`, kept
  instead of printed.
- The test client claims `completionItem.snippetSupport`, as VS Code does: without it the server warns that Vue's
  template completions would use snippets.

### 8. Fixtures

- `imports/Icon.ucf`: its `<vue>` block gains `<script setup lang="ts">defineProps<{size?: number}>()</script>`.
- `packages/core/test/blocks/vue.spec.ts`: Icon's row becomes `scriptSetup: true`; `imports/VueOnly.ucf` joins as the
  template-only row.

## Tests

All in `pnpm devx test`, on this host and in CI's `check` and `vue-floor` jobs: tsserver and the language server are
child processes, VS Code runs under the 2.11 harness.

`packages/e2e/editor/vue-block-features.spec.ts` (new), tsserver with our plugin linked to the source language server
(`TSDK`) by `relayTsserver()`, on `fixtures/components`:

- tsserver: hover on `{{ count }}` shows `number`; completion there lists `count`; definition lands on `const count`;
  `$style.buton` is one `TS2551`, `Counter.ucf` as written has none; `<Icon :size="'big'" />` in `UsesIcon.ucf` is one
  `TS2322` inside the attribute, none as written; hover and definition on `vue/CounterCrlf.ucf` too.
- Language server: `<sp|` lists `span`, `div` and `Counter`; before `class` in `<span class="label">` lists `:id`,
  `@click` and `v-if`; at `color` in `<style scoped>`, completion lists `color` once and the hover has its docs once
  (completion items are merged by label, so only the hover catches Vue's `css` plugin); no warning or error in the
  server log.
- `vue/AttrInside.ucf`: two `framework-in-block` from tsserver at the specifiers, none from the language server.
- After review: `UsesIcon.ucf` importing `./ReactOnly.ucf` from `<vue>` is `missing-target-block` naming
  `UsesIcon.ucf`; `:size` is offered before the end of `<Icon />`; tsserver's `_multifront:getComponentDirectives`
  lists Vue's directives (a local `vFocus` binding is not in them: Vue's own request function reads only the global
  ones, so completion cannot pin this handler); `class="counter"` links to `.counter`; a `<template>` never closed in
  `<vue>` is Vue's SFC error at its tag. The relay helper logs a failed request instead of answering it silently.
- `VUE_REQUESTS` and `vueRequestCommand()` live in `blocks/vue.ts`, so the server never loads Vue's request functions.

`packages/e2e/editor/vscode/suite.cjs`: in `checks`, completion before `class` in `Counter.ucf`'s `<span>` lists
`@click` through the relay; in `withoutTypescript`, the same position lists `v-if`.

Existing editor tests stay green.

## Docs

- `docs/milestones/m4-vue-target.md`: 4.12 text to what shipped, the two suite checks, `- Status: done`.
- `docs/architecture.md`, "Inside a `.ucf` file": how the server asks tsserver.
- `publicdocs/05-editor-setup.md`: `<vue>` gets its own row.

## Fuzzing

None.

## Out of scope

- 4.13: `.ts` importers resolving to `Card.ucf.vue.ts`, the bundled `typesRoot` copy.
- 4.14: `.vue` importers beside Vue's plugin.
- Vue client methods beyond the five, and the three plugins waiting for code id `main`.

## Done when

- Vue's template services run on `<vue>` blocks in the language server, fed by tsserver through the relay; a `<vue>`
  block's `.ucf` imports follow the in-block rule.
- Every test above passes; `pnpm devx check` green; docs updated; 4.12 ends with `- Status: done`.
- This todo is in `docs/done/`, updated to what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
