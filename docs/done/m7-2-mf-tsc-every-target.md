---
type: feature
spec: full-plan
status: done
created: 2026-10-15
milestone: 7
step: 7.2
---

# mf-tsc checks every target of every .ucf file

## Problem

`mf-tsc` (7.1) checks only a `.ucf` file's own script, its `<react>` block. A `<vue>` or `<svelte>` block that breaks
its framework passes, unless some importer picks that target. A `with {framework: 'vue'}` pick even resolves to
`Card.ucf.vue.ts`, a file that is not in the program. Spec 5 says `mf-tsc` checks every target, and spec 11 says it
catches a named export one target lacks. There is also no `--framework` option, so an agent cannot check one
framework of one file.

The milestone's first risk holds, read in `@volar/typescript` 2.4.28 `lib/node/proxyCreateProgram.js`: it only
`console.warn`s on `getExtraServiceScripts`. So, as the step allows, 7.2 uses what M4 built for tsserver: each served
target's script is a program file of its own, `Card.ucf.<target>.ts` (`targetScriptName`), mapped back into the `.ucf`
file by a target `Language` (`createTargetLanguage`, `src/targetScripts.ts:87`). The language plugin gets no
`getExtraServiceScripts`: it would only add Volar's warning in both hosts.

## Decisions

Answers from the run-milestone orchestrator:

1. No svelte compiler: exit 2, `mf-tsc: svelte is not installed in <root>; add it to devDependencies`, only when a
   file checked in svelte has a `<svelte>` block (`--framework react`, or a project with no `<svelte>` block, runs
   without svelte). The milestone's "A missing tool is exit 2" bullet names svelte.
2. Svelte markup the parser rejects: a `svelte-parse-error` finding with the build's code and message, at Svelte's
   position. A core helper shapes the message and position only; language-tools loads the compiler.
3. Unmapped diagnostics: on the target block's opening tag in `mf-tsc` only; tsserver keeps Volar's behaviour. The 7.2
   Build line says "in `mf-tsc`".
4. Empty after `--framework`: exit 2, `mf-tsc: ui holds no file of tsconfig.json to check in svelte`, and
   `mf-tsc: tsconfig.json holds no file to check in svelte` with no path (`in vue or svelte` for two). The
   milestone's "a path with no file to check" bullet names the case.

Decided while building (automatic mode):

- A generator's unused helper is left out even when unmapped: with `noUnusedLocals` the Vue and Svelte scripts flag
  `__VLS_components`, `__ucfRest` and the like (`reportsUnnecessary`), which the user cannot fix. Every other unmapped
  diagnostic lands on the opening tag. Pinned by the valid app under `noUnusedLocals` and `noUnusedParameters`.

## Plan

### 1. Target scripts in a program (`packages/language-tools/src/targetScripts.ts`)

- New export `programTargetScripts(ts, main: Language<string>)`, for a program host. It builds one target language
  per served kind with the existing `createTargetLanguage(main, kind, ts.sys.useCaseSensitiveFileNames)` and returns:
  - `namesOf(ucf): string[]`: `targetScriptName(ucf, tag)` for each served target whose script exists.
  - `scriptOf(fileName): TargetScript | undefined`: the script behind a `Card.ucf.<target>.ts` name.
  - `parse(fileName): {ucf, target} | undefined`.
  - `languageOf(target)`: the target language; `tsc/program.ts` maps with Volar's `transformDiagnostic` and asks it
    whether some mapping covers a span whatever its feature flags (`mapsAnywhere`), so "generated code with no
    mapping" is told apart from "mapped, but the tool hides it" (Vue's `verification: false`).
- tsserver's `serveTargetScripts` is unchanged.

### 2. The program (`packages/language-tools/src/tsc/program.ts`, new)

`createChecked` (`tsc/index.ts:101`) moves here, extended:

- **Host.** Wraps `ts.createCompilerHost(options)` and caches each parsed `SourceFile` by name, so a second pass parses
  nothing again. A target script name gets `ts.createSourceFile(name, script text, …, script.scriptKind)`, and
  `fileExists` says whether the script exists.
- **Roots.** Inside `inner`, after Volar's `setup` gave us `main`: the tsconfig's root names plus `namesOf(ucf)` for
  every root `.ucf` file. After the program is built, any `.ucf` file it reached (by an import, or as the `.ucf` of a
  target script it reached) missing as a root is added with its target scripts, except under `node_modules`, and the
  program is rebuilt with `oldProgram`, until nothing is added.
- **Raw diagnostics.** `inner` keeps the program's syntactic and semantic functions after `withImportErrors` wraps
  them and before Volar decorates them, so our import errors apply to target scripts too, as in tsserver.
- **`Checked.check(fileName, targets)`** returns a `CheckedFile` already in the user's file: `diagnostics` (each with
  its target) and `errors` (the `svelte-parse-error`, reported with `framework: 'svelte'`). `Checked` and
  `CheckedFile` live in `src/types.ts`.
  - a file that is not `.ucf`: the decorated program's diagnostics, as in 7.1;
  - a `.ucf` file: `react` (`MAIN_SCRIPT_TARGET`) is its own script's raw diagnostics mapped with Volar's
    `transformDiagnostic(main, …)`; `vue` and `svelte` are `Card.ucf.<target>.ts`'s, mapped with Volar's
    `transformDiagnostic(languageOf(target), …, true)`. Each comes
    with its target;
  - a diagnostic no mapping covers goes to the target block's opening tag, `[block.start, block.contentStart)`, code
    and message kept; one mapped but filtered out by the tool's flags stays dropped, as `vue-tsc` drops it, and so
    does a generator's unused helper (`reportsUnnecessary`).
- **`Checked.files()`**: the program's source files, minus default libs, `node_modules` and target script names.
- **Svelte.** A checked `<svelte>` block with no compiler is exit 2 (decision 1); an install that is found but does not
  load gives its own error instead of "not installed". With a compiler but no script, the
  block's markup is parsed with the compiler and core's new `svelteParseError(err, block, split)` (shared with the
  build's `parseBlock`) gives the `svelte-parse-error` finding (decision 2).

### 3. `mf-tsc` (`packages/language-tools/src/tsc/index.ts`)

- New option `framework` (`multiple`, `<name>`, "check .ucf files only in this framework: vue, react or svelte;
  repeat for more"), after `project`. Summary `Type-checks .ucf files in every framework, with the .ts and .tsx files
  that import them.`, example `mf-tsc src/Card.ucf --framework svelte --format json`.
- `--framework` is checked before TypeScript is loaded (after `runCommand`'s path check): any value outside `TARGETS`
  is exit 2,
  `mf-tsc: unknown framework 'angular'; use vue, react or svelte` (`orList` exported from `@multifront/core`).
- The targets checked: the given frameworks (deduped), or all three. Per `.ucf` file, those of them with a block.
  A named `.ucf` file with none is exit 2, `mf-tsc: ReactBreaks.ucf has no <svelte> block` (`has no <vue> or <svelte>
  block`); under a folder or with no path it is skipped and not counted. Files that are not `.ucf` are always checked.
  Empty only because of the filter: decision 4.
- `tscFinding(ts, diagnostic, split?, target?)`: `framework` is the checked script's target. A file's splitter errors
  are reported once, with no `framework`.
- Summary, JSON data and the file count are unchanged: target scripts are never counted or listed.

### 4. Docs moved to what ships

- `docs/milestones/m7-full-editor-support.md`: 7.2's Build line names the program files in place of
  `getExtraServiceScripts` and says "in `mf-tsc`"; `- Status: done`; the first risk says how 7.2 solved it; the
  "Hands to later milestones" bullet says every served target's script is a program file of `mf-tsc`; the shared
  rules name svelte as a tool and the `in svelte` empty case.
- `docs/architecture.md`, `mf-tsc` bullet: target scripts as program roots, the unmapped fallback, `--framework`.
- `docs/spec.md`, `docs/plan.md`: unchanged. `publicdocs/`: the milestone's docs writer.

## Tests

All run on this host and in CI's `check` and floor jobs (`pnpm devx test`): child processes only, no new infra.

### Fixtures, added to `packages/e2e/fixtures/apps/types-broken/`

- `VueBreaks.ucf`: valid `<react>` and `<svelte>`; `<vue>` has `{{ label.toFixed(2) }}` with `label: string`.
- `SvelteBreaks.ucf`: valid `<react>` and `<vue>`; `<svelte>` markup has `{label.toFixed(2)}`.
- `OnlyReactExport.ucf`: `<react>` exports `size` beside its default; `<vue>` and `<svelte>` a default only.
- `main.ts`: `import {size} from './OnlyReactExport.ucf' with {framework: 'vue'};`.
- `tsconfig.json` `include`: `["*.ucf", "*.ts", "pages"]`.

### `packages/e2e/editor/lib/tsc.ts` (new)

Shared by both specs: `span`, `line`, `withCopy`, `editFile`, `addFile`, `assertNoConfigAbove`,
`assertNotInstalled(dir, name)`, `linkTypeScript(dir)`, `fails`, `report`, and the broken app's findings with the text
each spans (`BROKEN_FINDINGS`).

### `packages/e2e/editor/tsc/every-target.spec.ts` (area Editor), real `mf-tsc` on `copyApp()` copies

1. Broken app, whole project: exit 1; in JSON the exact findings, each `.ucf` one inside its `block`, `framework` set
   (the readable lines, the summary and the text each span covers are pinned in `react.spec.ts`).
2. Valid `types-every-target/` (all three targets): exit 0, summary only (pinned in `react.spec.ts`), also with
   `noUnusedLocals` and `noUnusedParameters`.
3. tsserver parity: the real tsserver with our plugin opens `VueBreaks.ucf`, `SvelteBreaks.ucf`, `main.ts` and a temp
   `VuePicks.ucf` whose `<vue>` block imports `./ReactBreaks.ucf` (our `missing-target-block` inside a target script);
   its codes and spans equal `mf-tsc`'s findings for each. Under `<!-- @vue-ignore -->` (a mapping with
   `verification: false`) both hosts report nothing for `VueBreaks.ucf`.
   Reached only through imports: `include: ["pages"]` with a `.tsx` importing `VueBreaks.ucf` and a `.ts` picking
   `SvelteBreaks.ucf` `with {framework: 'svelte'}`: both files' block errors are reported.
4. One framework: `mf-tsc SvelteBreaks.ucf --framework svelte --format json` gives only the Svelte finding;
   `--framework react` on it exits 0; `--framework svelte` twice reports it once; `--framework vue --framework svelte`
   on `VueBreaks.ucf` the Vue one only.
5. A folder: `mf-tsc pages --framework svelte` still reports `main.tsx`'s finding; `--framework svelte` with no path
   skips the files with no `<svelte>` block in the count.
6. Nothing imports a target: a temp template error in `OnlyReactExport.ucf`'s `<vue>`, `main.ts` deleted: reported.
7. Unmapped: `const $style = {}` in a temp copy of `Greeting.ucf`'s `<react>`: TS2451 at the user's line and one on
   the `<react>` opening tag. In a target script: a `<script module>` `const` named like svelte2tsx's component
   (`SvelteBreaks__SvelteComponent_`) gives TS2451 at the user's line and one on the `<svelte>` opening tag.
8. Svelte markup that does not parse (`components/svelte/errors/UnclosedBrace.ucf` copied in): exactly the
   `findingOf` of what the real `buildTarget(…, 'svelte')` throws, `framework: 'svelte'`.
9. Exit 2, stdout empty, one exact stderr line: `ReactBreaks.ucf --framework svelte`, `--framework angular`, a folder
   and a project empty after `--framework`, a `copyAppOutside()` copy with typescript but no svelte (while
   `--framework react` there still runs), and the same copy with a svelte install that throws on load (its own error).

### `packages/e2e/editor/tsc/react.spec.ts` (7.1, updated, nothing loosened)

The 7.2 help; the unknown option names `--framework`; the whole-project cases expect the broken app's full findings
and `checked 7 files`; `editFile` calls use the new `include`.

## Fuzzing

None: the only oracle, tsserver against `mf-tsc` on mutated blocks, costs a tsserver round per case. The parity test
runs it on the fixtures.

## Out of scope

- `.vue` importers and the final help (7.3). The CI gate over every fixture (7.12).
- tsserver reporting unmapped diagnostics. Honouring the plugin entry's `frameworks` list in `mf-tsc`.

## Done when

- One `mf-tsc` run fails when any target of any `.ucf` file is broken, imported or not; `--framework` limits the
  `.ucf` checks; findings carry the right `block` and `framework`.
- The tests above pass in `pnpm devx check`; the docs above are updated; this spec is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
