---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 2
step: 2.8
---

# Milestone 2.8: Imports inside a `.ucf` block

## Problem

Spec 4.1: an import inside `<react>` always gets React, a `framework` attribute there is an error, and the imported
file must have a `<react>` block, or the error names both files. Today tsserver has no plugin of ours, and Volar's
default resolver sends every `./X.ucf` to the file's main script, with no rules and no errors.

Found while planning:

- 2.8's test runs "through the real tsserver with our plugin (2.9's helper)", and 2.8's Build has "the TypeScript
  plugin's host calls `resolveUcfImport`". So the plugin entry, the `./typescript-plugin` subpath, the real
  `typescript-plugin/` folder and `editor/lib/tsserver.ts` must exist now. Nothing of the plugin exists yet
  (`packages/language-tools/package.json` exports only `.` and `./server`).
- `createLanguageServicePlugin` (`@volar/typescript/lib/quickstart/createLanguageServicePlugin.js`) calls our callback
  before it wraps `info.languageService` in its proxy, and Volar wraps `resolveModuleNameLiterals` before
  `setup(language)` runs (`languageServicePluginCommon.js`): a wrapper set in `setup` sees `.ucf` literals first. This
  is spike 1's setup.
- The Volar proxy maps diagnostics from the script back to the `.ucf` file (`proxyLanguageService.js:643`): import
  errors added on the inner service, before the proxy, land on `.ucf` lines with no mapping code of ours.
- `missing-target-block` is planned in M3 3.6 (`m3-react-and-imports.md:120`). README "One code per error / codes join
  M1's `DiagnosticCode`": it joins the union now that the editor reports it.
- `packages/e2e/fixtures/components/editor/` has no tsconfig; the nearest one (`packages/e2e/tsconfig.json`) does not
  include fixtures, so tsserver would put `Profile.ucf` in an inferred project with no `jsx` option.
- `listComponents('editor')` feeds the 2.2 grammar test and the 2.4 virtual code snapshots: new files there need
  committed snapshots and must stay splitter-valid.

## Plan

### 1. Core: the code

- `packages/core/src/types.ts`: `'missing-target-block'` joins `DiagnosticCode` (not `TargetErrorCode`:
  `resolveTarget` never returns it in M2).

### 2. `packages/language-tools/src/resolve.ts`

```ts
/** What `resolveUcfImport` needs from its program: the tsserver plugin now, `mf-tsc` in M7. */
export interface UcfImportOptions extends ResolveTargetOptions {
  compilerOptions: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
  getSplit(fileName: string): SplitResult | undefined; // the open buffer when there is one
}
export interface UcfResolution {
  resolvedModule: ts.ResolvedModuleFull | undefined; // the .ucf file itself, served as its target's script
  target?: Target;
  rule?: TargetRule;
  error?: {code: DiagnosticCode; message: string}; // reported at the import
}
export function resolveUcfImport(ts, literal: ts.StringLiteralLike, containingFile: string, options: UcfImportOptions): UcfResolution;
export function readMultifrontOptions(ts, configFileName: string): ResolveTargetOptions;
```

- Attribute from `literal.parent`: `ImportDeclaration` / `ExportDeclaration` `.attributes`, or an `import()`
  `CallExpression`'s second argument `with` object. The `framework` value counts only as a string literal (non-literal
  is M3). Read with `.text`, so the single parent link is enough.
- Importer: `{fileName: containingFile}`, and when it ends in `.ucf`, `block` = the main script's target,
  `MAIN_SCRIPT_TARGET = 'react'` exported from `languagePlugin.ts` (which `getServiceScript` uses too).
- `resolveTarget(importer, attribute, options)`; on error → `{resolvedModule: undefined, error}`.
- File: `ts.resolveModuleName(text, containingFile, compilerOptions, ucfHost)`, no cache (the answer depends on the
  importer). `ucfHost.fileExists` answers `X.d.ucf.ts` with "does `X.ucf` exist", as Volar's resolver does, so `paths`
  and packages work as for any import. No file → `{resolvedModule: undefined}` (TypeScript's own TS2307).
- `getSplit(file).targets[target]` missing → `missing-target-block`, naming both files:
  `../imports/VueOnly.ucf has no <react> block; ImportErrors.ucf imports it as react` (path relative to the importer).
- Target row in `EDITOR_BLOCK_KINDS` has no `types()` (vue, svelte in M2) → unresolved, no error of ours (2.9 adds the
  message naming the target).
- Else `{resolvedModule: {resolvedFileName: <abs .ucf>, extension: '.tsx', isExternalLibraryImport}, target, rule}`.
- `readMultifrontOptions`: `ts.readConfigFile` + `ts.parseJsonConfigFileContent` with a `readDirectory` returning `[]`
  (no file glob, `extends` followed), our entry (`name === '@multifront/language-tools/typescript-plugin'`) from
  `options.plugins`: `framework` when `isTarget`, `importers` values when `isTarget`. One private
  `entryOptions(compilerOptions)`, which the plugin calls on the live `compilerOptions` tsserver hands
  `resolveModuleNameLiterals`, so a tsconfig edit counts without a restart.
- `index.ts` exports `resolveUcfImport`, `readMultifrontOptions` and the two types (in `types.ts`).

### 3. `packages/language-tools/src/typescriptPlugin.ts`, subpath `./typescript-plugin`

- `export default createLanguageServicePlugin((ts, info) => ...)` with `createUcfLanguagePlugin()` (no compiler yet:
  2.9 passes `loadVueCompiler`, as the hand-off says).
- `setup(language)`: wraps `info.languageServiceHost.resolveModuleNameLiterals`. `.ucf` literals → `resolveUcfImport`;
  the rest, in one batch, → the previous (Volar's) function; results merged back in order. `getSplit` reads
  `language.scripts.get(f)?.generated?.root.split`, so unsaved buffers count.
- Import diagnostics: in the callback, `info.languageService` is replaced by a wrapper whose `getSemanticDiagnostics`
  walks the program's source file (import / export declarations, `import()` calls with a `.ucf` specifier), calls
  `resolveUcfImport` again (pure, no stored state, so reused resolutions cannot drop an error) and adds per `error`
  `{file, start: literal.getStart(sf), length: literal.getWidth(sf), category: Error, code, source: 'multifront',
  messageText}`. `code` is our string code (cast: `ts.Diagnostic.code` is typed `number`). TypeScript's own TS2307 /
  TS2792 on the same literal is dropped: one problem, one error. The Volar proxy wraps this, so positions map to `.ucf`.
- Covers `.ts` / `.tsx` importers too (one program); their `unknown-framework` / `no-target` come out the same path
  (2.9 tests those rows).
- `package.json`: `exports["./typescript-plugin"]` = `{source: ./src/typescriptPlugin.ts, types:
  ./dist/typescriptPlugin.d.ts, default: ./dist/typescriptPlugin.js}`; `files` gains `typescript-plugin`. New
  `packages/language-tools/typescript-plugin/index.js`:
  `export {default as 'module.exports'} from '@multifront/language-tools/typescript-plugin';` (spike 1, answer 4).

### 4. Fixtures

- `packages/e2e/fixtures/components/editor/Profile.ucf`: `<react>` imports `../Badge.ucf` and `../Card.ucf`, renders
  `<Card title="Ada" />` and `<Badge label="Admin" />`.
- `editor/ImportErrors.ucf`: `<react>` imports `../Card.ucf` (renders `<Card />`, no `title`), `../imports/VueOnly.ucf`,
  and `../Badge.ucf` with `{ framework: 'vue' }`.
- `packages/e2e/fixtures/components/imports/VueOnly.ucf`: `<vue>` only. New shared folder.
- `editor/tsconfig.json`: the imports app's compiler options (`jsx: react-jsx`, `module: preserve`,
  `moduleResolution: bundler`, `strict`, `noEmit`, `skipLibCheck`), `include: ["*.ucf"]`, no plugin entry (the global
  plugin serves it), so tsserver opens these files in a configured project, as a user's project would. Without it
  they land in an inferred project with no `jsx` option, and `Profile.ucf` gets TS7026 errors.
- New snapshots `editor/__snapshots__/virtualCode/editor/{Profile,ImportErrors}.ucf.react.tsx` (2.4's loop), committed.

### 5. Test helper `packages/e2e/editor/lib/tsserver.ts`

`startTsserver({cwd, plugins}): Tsserver` with `request(command, args)`, `diagnostics(file)` (syntactic +
semantic sync commands) and `stop()`. Spawns `process.execPath --conditions=source <typescript 6.0.3>/lib/tsserver.js
--globalPlugins <plugins> --pluginProbeLocations packages/e2e --disableAutomaticTypingAcquisition`: the plugin is found
as installed in `packages/e2e/node_modules`, as `lsp.ts` does for the server. Content-Length protocol, responses
matched by `request_seq`, `success: false` rejects. Files open with `updateOpen` (which answers, unlike `open`).

## Decisions

- TS diagnostics carry our string code (`'framework-in-block'`) with `source: 'multifront'`: same code as the language
  server. The test reads `code` from the real tsserver response; if tsserver dropped it, fall back to `code: 0` and the
  code name in the message.
- 2.8 builds the plugin entry, the `./typescript-plugin` subpath, the `typescript-plugin/` folder and
  `editor/lib/tsserver.ts`, because its own test needs them. 2.9 keeps the rest.
- TypeScript's TS2307 / TS2792 on a literal where our error stands is dropped: one problem, one error.

## Tests

All run on this host and in CI's `check` job through `pnpm devx test`: child processes only, which the README table
lists as "nothing to add".

- `packages/e2e/editor/blockImports.spec.ts` (area **Editor**), one tsserver with
  `@multifront/language-tools/typescript-plugin`:
  - `Profile.ucf`: `quickinfo` on `<Card` shows `{ title: string; }`; `definition` on `Card` gives `Card.ucf` with a
    span inside its `<react>` content (from the real `splitBlocks`); no diagnostics in the file (both imports resolve).
  - `ImportErrors.ucf`: TS2741 (missing `title`) on the `<Card />` line; `missing-target-block` on the `VueOnly.ucf`
    import line, message naming `VueOnly.ucf` and `ImportErrors.ucf`; `framework-in-block` on the `Badge.ucf` import
    line; both with `source: 'multifront'`; no TS2307 on either line.
- `packages/language-tools/test/resolve.spec.ts` (package test, mirrors `src/resolve.ts`): for every row of
  `EXPECTED_IMPORTS`, `readMultifrontOptions(ts, <nearest tsconfig.json>)` equals the row's `options` (fixture read by
  relative path, as core's tests do); `components/editor/tsconfig.json` gives `{}`.

## Docs

- `docs/milestones/m2-editor-basics.md`: 2.8 Build names the plugin entry, subpath, folder, `UcfImportOptions`, the
  code and source on TS diagnostics and the dropped TS2307; Test names the helper as built here; `- Status: done`.
  2.9 Build keeps the compiler, the `mixed.ts` warning and the no-types message; helper becomes 2.8's. Hand-offs:
  `resolveUcfImport` signature and options, `MAIN_SCRIPT_TARGET`, `startTsserver(...).stop()`, `missing-target-block`,
  `editor/tsconfig.json` in the fixtures line.
- `docs/milestones/m3-react-and-imports.md:120`: `missing-target-block` already joined `DiagnosticCode` in M2.
- None in spec / plan / architecture (`architecture.md:105` already describes this); no public page covers the editor.

## Fuzzing

None: the step names no fuzz test and has no cheap oracle beyond 2.7's fixture table.

## Out of scope

- The `mixed.ts` warning, the vue / svelte "no types yet" message, `loadVueCompiler` in the plugin, the 2.9 test cases.
- `framework-attribute-not-literal`, `importerFromId`, the `Card.ucf.<target>.tsx` importer names (M3).
- Re-resolving an importer when the imported file gains its block in an unsaved edit (TypeScript reuses the resolution
  until the importer changes).

## Done when

- Both tests pass, and fail with the resolution wrapper removed.
- `pnpm devx check` green; snapshots committed; milestone and M3 docs updated.
- The simplify-comments pass ran on every touched source file, committed on its own.
