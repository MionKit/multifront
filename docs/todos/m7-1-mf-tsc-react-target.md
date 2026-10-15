---
type: feature
spec: full-plan
status: ready
created: 2026-10-15
milestone: 7
step: 7.1
---

# mf-tsc for the React target and its importers

## Problem

Nothing on the command line type-checks a `.ucf` file. Plain `tsc` sees no `.ucf` types (spec 5), and the TypeScript
plugin only runs inside tsserver. Milestone 7 step 7.1 adds `mf-tsc`: it checks the `<react>` block of every `.ucf`
file and the `.ts` / `.tsx` files that import them, follows the command rules (spec 8.1) and can check one file, a
folder or the whole project. `runCommand` takes no paths and no short options yet, and `mf-tsc` needs both.

## Decisions

Answers from the run-milestone orchestrator:

1. Import errors: a shared `withImportErrors()` used by the TypeScript plugin and `mf-tsc` (spec 5: the editor and the
   build cannot disagree; spec 8.1: our codes; 7.2 compares with tsserver code for code). architecture.md's `mf-tsc`
   bullet says so.
2. 7.1 help: `Type-checks the <react> block of .ucf files, with the .ts and .tsx files that import them.`, example
   `mf-tsc src/Card.ucf --format json` (help text must be true; 7.1 has no `--framework`). The milestone's "Help
   texts" paragraph names them; 7.2 moves to the final text.
3. Missing path: `mf-tsc: nope.ucf does not exist`, printed by `runCommand` for every command. Spec 8.1's "One file
   or folder" bullet gets the example line.
4. `tscFinding(ts, diagnostic, ucf?)` is the private signature; the milestone line says so.

## Plan

### 1. `runCommand` takes paths and short options (`packages/core`)

- `src/types.ts` `CommandOption`: `Pick<ParseArgsOptionDescriptor, 'type' | 'multiple' | 'short'>`.
- `src/types.ts` `CommandSpec`: new optional `paths: string`, the help text of the paths argument.
- `src/command.ts`:
  - `SHARED_OPTIONS.help` gets `short: 'h'`. The two places that name `help` for `-h` go: `helpText` prints
    `-${short}, --${name}` for any option with `short`; `parse` passes each option's own `short`.
  - `helpText`: usage line `Usage: <name> [options] [paths...]` when `spec.paths` is set, else
    `Usage: <name> [options]` as now. `spec.paths` is printed as the last summary line.
  - `parse`: positionals allowed only when `spec.paths` is set; else today's
    `unexpected argument 'x'; mf-build takes options only`. Returns `{values, paths}`.
  - `runCommand(spec, args, run)`: `run(values, paths)`. Each path is resolved against the cwd and checked to
    exist before `run`: a missing one is exit 2, `mf-tsc: nope.ucf does not exist` (the path as written). `paths`
    reach `run` absolute, in the order given. `--help` still wins over everything.
- `mf-build` (`packages/vite/src/library/cli.ts`) is unchanged: its help and messages stay byte for byte.

### 2. A shared folder walker (`packages/language-tools/src/files.ts`, new)

- Move `filesUnder(dir, suffix, skipped?)` from `src/svelteDeclarations.ts` into `src/files.ts`, exported;
  `svelteDeclarations.ts` imports it. `mf-tsc` uses it for every `tsconfig.json` below a named folder (basename
  exactly `tsconfig.json`). 7.6 adds `ucfFiles(paths, ignored)` to the same file.

### 3. Import errors shared by the plugin and `mf-tsc` (`src/importErrors.ts`, new)

- Move `ucfLiterals`, `importErrors` and the "covered" filter out of `src/typescriptPlugin.ts` into one exported
  `withImportErrors(ts, sourceFile, diagnostics, options): ts.Diagnostic[]`: our import errors
  (`missing-target-block`, `framework-in-block`, `unknown-framework`, `no-target`, `target-not-enabled`,
  `framework-attribute-not-literal`, the `mixed-frameworks` warning) added, TypeScript's own errors on the same
  import dropped. The TypeScript plugin calls it in its `getSemanticDiagnostics` as today (no behaviour change);
  `mf-tsc` calls it on its program, so a bad `.ucf` import gives the same code in the terminal as in VS Code instead
  of `TS2307 Cannot find module`.

### 4. `mf-tsc` (`packages/language-tools/src/tsc/index.ts`, new)

Exports `runMfTsc(args): Promise<number>` = `runCommand(MF_TSC, args, check)`.

Spec (help pinned by the test; 7.1 help has no `--framework` line, 7.2 and 7.3 change summary and example):

```
Usage: mf-tsc [options] [paths...]

Type-checks the <react> block of .ucf files, with the .ts and .tsx files that import them.
Paths are files or folders of the project; none checks the whole project.

Options:
  -p, --project <file>   the tsconfig.json to use (default: the nearest one above each path)
  --format <format>      text or json (default: text)
  -h, --help             show this help

Example:
  mf-tsc src/Card.ucf --format json

Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
```

TypeScript is loaded from the project: `createRequire(join(cwd, 'package.json')).resolve('typescript')`. If it
cannot be resolved: exit 2, `mf-tsc: typescript is not installed in <cwd>; add it to devDependencies`.

**Projects.** One cached record per tsconfig path: its `ParsedCommandLine` and its program, both built on first
use.

- Parse: `ts.getParsedCommandLineOfConfigFile(path, {}, host, …, extraFileExtensions)` with
  `[{extension: 'ucf', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred}]`, so `include` globs pick up
  `.ucf` files (as tsserver does for its plugin's extensions). An unrecoverable diagnostic (missing file, TS5083) or
  any `parsed.errors` entry (bad JSON, TS5023 unknown option, TS18003 no inputs) is exit 2, one line:
  `mf-tsc: tsconfig.json:3:5: error TS5023: Unknown compiler option 'foo'.`, plus ` (and N more)`; with no file,
  `mf-tsc: error TS5083: Cannot read file '<path>'.`. Paths shown relative to the cwd.
- Chain: a project, then its `references` (`ts.resolveProjectReferencePath`), depth first, each once.
- Program: `proxyCreateProgram(ts, inner, create)` from `@volar/typescript`, called with
  `{rootNames: parsed.fileNames, options: {...parsed.options, noEmit: true, allowNonTsExtensions: true},
  host: ts.createCompilerHost(options)}`. No `projectReferences` are passed: each project is checked on its own,
  importing its references' sources, as tsserver does. `noEmit` makes the tsconfig's emit options ignored.
  - `create` returns `createUcfLanguagePlugin({ts, compilerOptions, compiler, svelteCompiler})` (the Vue and Svelte
    compilers from `loadVueCompiler` / `loadSvelteCompiler` at the tsconfig's folder, left out when missing, as the
    TypeScript plugin does) and keeps Volar's `language` from `setup`.
  - `inner` runs inside Volar's proxy, after it set its own `host.resolveModuleNameLiterals`: it wraps that so every
    `.ucf` literal goes to `resolveUcfImport(ts, literal, containingFile, options, sourceFile)` (options:
    `entryOptions(compilerOptions)`, the host, `getSplit` from Volar's language), the rest to Volar's. Then it
    creates the program and wraps `program.getSemanticDiagnostics(sourceFile)` with `withImportErrors`, before
    Volar decorates the program, so Volar maps those into the `.ucf` file too.
- "Holds a file": `program.getSourceFile(file)` and not a default lib file.
- A project's files: its program's source files, minus default lib files and files under a `node_modules` folder.

**Which files, which project.**

- `-p <file>`: candidates are that project's chain only.
- A named file: its chain is `-p`'s, else the chain of `ts.findConfigFile(dirname(file))`. It goes to the first
  project there that holds it. No tsconfig above: exit 2, `mf-tsc: Alone.ts has no tsconfig.json above it; add one or
  pass -p`. None holds it: `mf-tsc: notes/Loose.ts is not part of tsconfig.json; add it to "include" or pass -p` (the
  nearest tsconfig).
- A named folder: candidates are `-p`'s chain, else the chain of `findConfigFile(folder)` plus the chain of every
  `tsconfig.json` below it (`filesUnder`, so `node_modules` and dot folders are skipped). Its files are the
  candidates' project files under the folder whose path below the folder has no `node_modules` or dot-folder
  segment. Each goes to the project a named file would go to (else the first candidate holding it). No candidate:
  `mf-tsc: empty has no tsconfig.json above or in it; add one or pass -p`. No file: `mf-tsc: empty holds no file of
  tsconfig.json`.
- No path: the chain of `-p`, else of `findConfigFile(cwd)`; every project's files, each file going to the first
  project holding it. No tsconfig: `mf-tsc: no tsconfig.json in . or above it; add one or pass -p`.
- All paths merge into one map project → file set: a file named twice, or inside a named folder, is checked once.

**Findings.** Per project with at least one file: `getGlobalDiagnostics()` and `getOptionsDiagnostics()` (no
file, e.g. TS2688), then per file `getSyntacticDiagnostics(sf)` and `getSemanticDiagnostics(sf)` (Volar already maps
`.ucf` diagnostics into the `.ucf` text), turned into `Finding`s by the private
`tscFinding(ts, diagnostic, ucf?: {split, framework})`:

- `code`: `TS${code}` for TypeScript's numbers, our string code as is.
- `severity`: Error → `error`, Warning → `warning`; Suggestion and Message are dropped, as `tsc` does.
- `message`: the chain flattened, levels joined with one space.
- `line`, `column`, `end` 1-based from `sourceFile.getLineAndCharacterOfPosition` (Volar's leading offset keeps
  `.ucf` line starts as in the real file).
- `.ucf` file: `block` = the block holding `start`, `framework: 'react'` (`MAIN_SCRIPT_TARGET`). A `.ts` / `.tsx`
  finding has neither.
- Each checked `.ucf` file also gives its `split.errors` through `findingOf` (no `framework`), beside TypeScript's.

**Result.** Summary `checked 3 files with tsconfig.json: 1 error` (`1 file`; `N errors`, `, N warnings` when
any, `no errors` when none; `checked 5 files with 2 tsconfigs: …` with several projects). Data
`projects: [{tsconfig, files}]`, `tsconfig` relative to the cwd, `files` a count, in check order.

### 5. The bin and the package

- `packages/language-tools/bin/mf-tsc.js`: `import {runMfTsc} from '#tsc'; process.exitCode = await runMfTsc(...)`,
  as `mf-build.js` does.
- `packages/language-tools/package.json`: `"bin": {"mf-tsc": "./bin/mf-tsc.js", …}` and
  `"imports": {"#tsc": {"source": "./src/tsc/index.ts", "default": "./dist/tsc/index.js"}}`. No new dependency
  (`@volar/typescript` and the `typescript` peer are already there).

## Tests

All run on this host and in CI's `check` job (`pnpm devx test`) and the floor jobs: only child processes, no new infra.

### `packages/e2e/editor/tsc/react.spec.ts` (area Editor)

New helper `packages/e2e/editor/lib/commands.ts`: `runBin(packageName, bin, cwd, args)` spawns the real bin from the
package's `bin` field with `node --conditions=source`, returns `{code, stdout, stderr}` (7.6 and 7.8 reuse it).

New fixtures:

- `packages/e2e/fixtures/apps/types-every-target/` (valid): `tsconfig.json` (our plugin entry, `framework: 'react'`),
  `Greeting.ucf` (`<react>`, `<vue>`, `<svelte>` blocks and a `<style module>` used as `$style` in `<react>`; its
  `<react>` imports `./Badge.ucf`), `Badge.ucf` (all three blocks), `main.tsx` (renders `<Greeting>` with right props),
  `picks.ts` (`import Greeting from './Greeting.ucf' with {framework: 'react'}`).
- `packages/e2e/fixtures/apps/types-broken/`: `tsconfig.json` (`include: ["*.ucf", "pages"]`), `ReactBreaks.ucf`
  (only `<react>`: `<Label text={42} />` with `text: string`), `Title.ucf` (valid `<react>`, `text: string`),
  `pages/main.tsx` (`<Title text={1} />`).

Cases, every one on a `copyApp()` copy (`removeApp()` after):

1. Whole project: valid app, exit 0 and stdout exactly `mf-tsc: checked N files with tsconfig.json: no errors`;
   broken app, exit 1, stdout exactly the `ReactBreaks.ucf:…: error TS2322 (react): …` line, the
   `pages/main.tsx:…: error TS2322: …` line and `mf-tsc: checked 3 files with tsconfig.json: 2 errors`.
2. `--format json` on the broken app: the exact document (`block` and `framework` on the `.ucf` finding only,
   `projects: [{tsconfig: 'tsconfig.json', files: 3}]`). Each finding's `line:column` to `end` is the text
   TypeScript marks in the fixture (the `text` prop), checked against the fixture text.
3. One file: `mf-tsc ReactBreaks.ucf` only its finding, `checked 1 file`. One folder: `mf-tsc pages` only
   `main.tsx`'s; the copy adds `pages/node_modules/broken/index.ts` with a type error and lists it in its tsconfig
   `include`, and it is not reported. `mf-tsc ReactBreaks.ucf ReactBreaks.ucf` and `mf-tsc pages pages/main.tsx`
   each report their finding once.
4. From the repo root: the copy's `ReactBreaks.ucf` by its path, with the tsconfig found above it, then again with
   `-p <copy>/tsconfig.json`: same finding and summary, paths relative to the repo root. Both apps in one run (a
   valid copy with a temp wrong prop in `main.tsx`, plus `ReactBreaks.ucf`): two `projects` entries, a finding from
   each, `checked 2 files with 2 tsconfigs: 2 errors`.
5. References: copy whose `tsconfig.json` becomes `{"files": [], "references": [{"path": "./tsconfig.app.json"}]}`
   and `tsconfig.app.json` the original. `mf-tsc` and `mf-tsc ReactBreaks.ucf` report the referenced project's
   errors, summary `with tsconfig.app.json`.
6. Copy whose tsconfig sets `types: ["nonexistent"]`: one TS2688 finding with no file, exit 1.
7. Copy with `components/invalid/DuplicateReact.ucf` added to the app: its `duplicate-target` findings, each equal to
   `findingOf(diagnostic, split)` of core's own split (file relative to the cwd).
8. Exit 2, stdout empty, one exact stderr line: unknown option (`use --project, --format or --help`),
   `--format xml`, a missing path, a file the tsconfig does not hold (`notes/Loose.ts` added to the copy), a file
   with no tsconfig above it (in `os.tmpdir()`), a folder holding no program file, `-p` to a missing file, a
   tsconfig with one unknown compiler option (its `file:line:col`), one with two (` (and 1 more)`), and an app copy
   in `os.tmpdir()` with its tsconfig but no typescript to load.
9. A copy with `pages/vue-pick.ts` importing `../ReactBreaks.ucf` `with {framework: 'vue'}`:
   `missing-target-block` at the specifier, no TS2307.
10. `--help` and `-h`: exit 0, the exact help above.

### `packages/core/test/command.spec.ts`

`command.child.ts` gets `short: 'n'` on `--name` and a `paths` line. Cases: the help prints `-n, --name <name>`,
`Usage: greet [options] [paths...]` and the paths line last in the summary; a path reaches `run` absolute; a
missing path is exit 2 with `greet: nope does not exist`. Existing cases updated to the new help text.

`packages/e2e/build/library-cli.spec.ts` stays as is and pins that `mf-build`'s help and messages did not change.

## Docs

- `docs/milestones/m7-full-editor-support.md`: `- Status: done` on 7.1; the 7.1 help summary and example as shipped;
  `tscFinding`'s signature; 7.6 reads `files.ts` as existing (only `ucfFiles` is new there).
- `docs/architecture.md`, "Editor and types": a bullet on `mf-tsc` (Volar's `proxyCreateProgram`, our language
  plugin, `resolveUcfImport` wrapped inside Volar's resolver, the shared import errors, one program per tsconfig,
  the given files' diagnostics). Its graphics unchanged (the hosts table already lists `mf-tsc`).
- `docs/spec.md` 8.1, "One file or folder": the missing-path example line.
- `README.md`: the `@multifront/language-tools` row names `mf-tsc`.
- `docs/plan.md`: unchanged. `publicdocs/`: written by the milestone's docs writer.

## Fuzzing

None in 7.1: no cheap oracle beyond the tsserver parity check, which 7.2's test does on every target.

## Out of scope

- `--framework`, other targets' scripts and unmapped diagnostics on a block's opening tag (7.2).
- `.vue` importers (7.3). `ucfFiles` (7.6). `CommandResult.warningsFail` (7.8).
- The packed-bin test and the speed timings (7.12). `--watch`, emitting, reuse between runs (milestone Out of scope).

## Done when

- `mf-tsc [paths]` checks `.ts` / `.tsx` importers and every `.ucf` file's `<react>` block, whole project, one file
  or one folder, readable or `--format json`, exit 0 / 1 / 2, findings at `.ucf` lines and columns.
- `runCommand` has `CommandSpec.paths` and `short`; `mf-build` output unchanged.
- The tests above pass in `pnpm devx check`; the docs above are updated; this spec is in `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
