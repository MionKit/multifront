---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.11
---

# Milestone 5.11: Svelte's own editor setup

## Problem

Svelte's language server (svelte-language-server 0.18.4, which also runs `svelte-check`) builds its own TypeScript service and never loads tsserver plugins. So a `.svelte` file that imports `./Card.ucf` gets "Cannot find module" in Svelte's editor and in `svelte-check`, because our TypeScript plugin is not there to resolve it. Inside tsserver, the `.svelte` importer case (the `src/Gallery.svelte` row that 5.9 left open) needs Svelte's own `typescript-svelte-plugin` loaded beside ours. That pairing has never been tested. Spec 11 still says "Svelte's extension needs checking".

Spikes I ran for this plan (scratch copies, real tools, pinned versions):

- **tsserver with both plugins**, in either load order. A `.ts` file importing `./App.svelte` and `Panel.ucf with {framework: 'svelte'}` types both: App is svelte2tsx's component (not Svelte's ambient `LegacyComponentType`), and Panel is `Component<…>`, with `heading: 1` as TS2322. `imports/src/Gallery.svelte` opened in tsserver has no diagnostics, its definition lands on `Card.ucf`, and the binding is `Component<…>`.
- **A prototype `emitSvelteTypes`** (a TS program over the `Card.ucf.svelte.ts` scripts, `.ucf` imports through `resolveUcfImport`, `emitDeclarationOnly`, writes redirected) writes 62 declarations for `fixtures/` in about 2 s. Example output: `declare const Panel__SvelteComponent_: import("svelte").Component<$$ComponentProps, {}, "">; export default …`. No shim reference is left in it. A cross-file import is kept as `import PanelItem from './PanelItem.ucf'`, so a mirrored layout resolves it. A JS block must be parsed as JS (`allowJs`), or its JSDoc props come out as `{}`.
- **`rootDirs`**:
  - svelte-check 4.7.6 on a `svelte-vite` copy gives TS2307 on every `.ucf` import in `App.svelte` and `main.ts`. With `"rootDirs": ["../..", "../../.ucf/svelte"]` plus the emitted files, all of them are gone.
  - svelte-language-server over LSP (`--stdio`, pull diagnostics) gives 2307 before the emit. After it (plus `didChangeWatchedFiles`), a wrong `heading={1}` is TS2322 at `heading` and hover shows `Component<$$ComponentProps…>`.
  - Both tools also load the app's `vite.config.ts` (through `@sveltejs/load-config` → `vite.resolveConfig`, bundling loader). A literal `@multifront/vite` import fails there: no `dist/` in CI, and that loader ignores `source`. This is the same case as `sveltekit-src` (5.6).

## Plan

### 1. `emitSvelteTypes` in `@multifront/language-tools`

New `packages/language-tools/src/svelteDeclarations.ts`, exported from `src/index.ts`:

```ts
export interface EmitSvelteTypesOptions {
  root: string;
  outDir?: string;       // default join(root, '.ucf', 'svelte')
  ts?: TypeScript;       // default: the project's own `typescript`, resolved from root
  svelteTypesRoot?: string; // passed to the scripts (the bundled server's copy)
}
export function emitSvelteTypes(options: EmitSvelteTypesOptions): string[]; // declaration files written
```

- **Finding files.** Walk every `.ucf` under `root`, skipping `node_modules`, dot folders below `root` and anything inside `outDir`. Keep only files with a `<svelte>` block (`splitBlocks`).
- **Loading the tools.**
  - Svelte: `loadSvelteCompiler(root)`. A missing Svelte throws core's "could not find svelte".
  - TypeScript: `options.ts`, else `typescript` resolved from `root`. A missing one throws `multifront: could not find typescript. Install typescript in your project.`; one found but broken throws its own error.
- **The scripts.** `blocks/svelte.ts:50` `svelteTypes` becomes an export, because it keeps `lang`. Each script is parsed with `ScriptKind.TS` or `ScriptKind.JS` by that `lang`.
- **Compiler options.**
  - Base: `<root>/tsconfig.json` when present (`ts.getParsedCommandLineOfConfigFile`, errors ignored). Otherwise `{target: ESNext, module: Preserve, moduleResolution: Bundler, strict: true, skipLibCheck: true}`.
  - Always overridden: `allowJs: true, declaration: true, emitDeclarationOnly: true, noEmit: false, noEmitOnError: false, declarationMap: false, sourceMap: false, composite: false, incremental: false`, and `outDir`, `declarationDir`, `rootDir`, `tsBuildInfoFile` set to undefined.
- **Compiler host.** `ts.createCompilerHost`, changed so:
  - `getSourceFile`, `fileExists` and `readFile` serve `<file>.ucf.svelte.ts` (`targetScriptName`) from a lazily built map. An imported `.ucf` outside `root` also gets its script, but no output.
  - `resolveModuleNameLiterals` sends `.ucf` specifiers to `resolveUcfImport`, the same block rule as tsserver. Everything else goes to `ts.resolveModuleName`.
- **Writing.** `program.emit(undefined, writeFile)`. Only `<scanned file>.ucf.svelte.d.ts` is written, to `<outDir>/<path relative to root>.d.ts`, so `src/Card.ucf` gives `.ucf/svelte/src/Card.ucf.d.ts`. Folders are created as needed.
- **Stale files.** A `*.ucf.d.ts` under `outDir` (skipping `node_modules` and dot folders, as the source walk does) whose `.ucf` file is gone or has no `<svelte>` block is deleted. A file whose script cannot be built yet keeps its last declaration.
- **Only `.ucf` scripts.** The host serves a script only for a name ending `.ucf.svelte.ts`: `Foo.svelte.ts`, probed for an `import './Foo.svelte'`, is left to TypeScript.
- **Return value.** The written paths, sorted. A relative `root` or `outDir` is resolved first (`createRequire` needs an absolute path).

### 2. Our language server calls it on save

`packages/language-tools/src/server.ts:75`: `startServer(options: ServerOptions = {})`, with the new `ServerOptions` in `types.ts`:

```ts
/** What a host bundling the server sets. */
export interface ServerOptions extends Pick<EditorOptions, 'svelteTypesRoot'> {
  onTypeScript?(ts: TypeScript): void; // called with the tsdk's TypeScript once it is loaded
}
```

- `server.documents.onDidSave`. Volar's server advertises `TextDocumentSyncKind.Incremental`, which vscode-languageclient turns into `save: {includeText: false}`, so VS Code sends it.
- It acts on a `file:` URI ending `.ucf` whose text has a `<svelte>` block, or whose declaration already exists (so removing the block cleans up).
- `root` is the deepest workspace folder holding the file. There is no emit when no folder holds it, or when there is no TypeScript.
- Registered in `onInitialize` once the tsdk's TypeScript loaded: no tsdk, no emit.
- Saves within 100 ms per root are one emit (Save All, auto-save), run after the last one.
- It runs `emitSvelteTypes({root, ts, svelteTypesRoot})` inside a try.
  - Success logs `multifront: wrote <n> Svelte declarations to <outDir>` (`connection.console.info`).
  - An error logs `multifront: no Svelte declarations for <root> (<reason>)` (`warn`).
- The bin stays `startServer()`.

### 3. The VS Code bundle runs it too

- New `packages/vscode/src/server.ts`:
  - `startServer({svelteTypesRoot: join(import.meta.dirname, 'svelte-types'), onTypeScript: (ts) => { globalThis[HOST_TYPESCRIPT] = ts }})`
  - It does what `src/typescriptPlugin.ts` does for svelte2tsx's `typescript` import.
- `scripts/lib/bundle-vscode.mjs:47`: the `server` entry becomes `src/server.ts`, and the comment changes to: the extension runs the same `startServer`, with the bundle's svelte types and TypeScript.
- `packages/vscode/src/bundle/hostTypeScript.ts:1-2`: the comment changes. The server now runs svelte2tsx too, with the tsdk's TypeScript.

### 4. Fixtures

- `fixtures/apps/svelte-vite/tsconfig.json`: add `"rootDirs": ["../..", "../../.ucf/svelte"]`, with a one-line comment that its `.ucf` files sit beside the app under `components/` (the usual app uses `["./src", "./.ucf/svelte/src"]`).
- `fixtures/apps/svelte-vite/vite.config.ts`: computed `@multifront/vite` import, as in `sveltekit-src`. svelte-check and Svelte's server load it through Vite's bundling loader.
- New `fixtures/apps/svelte-vite/src/mountAll.ts`: imports `./App.svelte` and `Panel.ucf with {framework: 'svelte'}`, then mounts both.
- `.gitignore`: add `.ucf/`.

### 5. Root devDependencies

`svelte-language-server` 0.18.4, `typescript-svelte-plugin` 0.3.52 and `svelte-check` 4.7.6, the milestone pins. All are older than 30 days (2026-08-13, 2026-05-01, 2026-08-13). Added with `pnpm add -Dw`, lockfile updated.

### 6. Test helpers

- `editor/lib/lsp.ts:34`: `startLanguageServer` gains `source?: boolean` (default `!server`), so a foreign server (Svelte's) can still run with `--conditions=source` for the vite config, and takes several folders for a multi-root workspace.
- New `editor/lib/svelte.ts`, with four helpers:
  - `SVELTE_PLUGIN = 'typescript-svelte-plugin'`
  - `SVELTE_SERVER`: the installed `svelte-language-server/bin/server.js` (`svelteserver --stdio`, as test-utils forks it), started with the source condition on.
  - `runSvelteCheck(app)`: spawns the installed `svelte-check` (`--workspace <app> --tsconfig ./tsconfig.json --output machine-verbose`, `NODE_OPTIONS=--conditions=source`, `NODE_PATH` unset) and parses each JSON problem line (`{type, filename, start, message, code}`) plus the exit code.
  - `saveUcf(server, file)`: opens a `.ucf` file in our server, sends `didSave`, resolves to the emit's log line.
- `editor/lib/cases.ts:141` `expectSvelteComponent`: for a `.svelte` file, the unsaved `const picked = <binding>;` goes before the first `</script>`.

## Tests

All tests run on this host and in CI's `check` job (`pnpm devx test`): Node child processes only, no browser, no VS Code. The `svelte-floor` job runs them too, on svelte 5.55.6.

### `packages/e2e/editor/svelte-editor-setup.spec.ts`

Runs on a `copyApp('svelte-vite')` copy. `<copy>` is the copy root, holding `apps/svelte-vite` and `components/`.

**tsserver with `typescript-svelte-plugin` and our plugin**, `describe.each` over both load orders (probe locations `E2E_DIR`), on a copy where `emitSvelteTypes` already ran, so our plugin's pick wins over a declaration `rootDirs` also finds. On `src/mountAll.ts`:
- no diagnostics;
- quickinfo on `App` is not `LegacyComponentType` (it is Svelte's plugin's script);
- unsaved `mount(App, {target, props: {nope: 1}})` is one TS2322;
- `heading: 1` on Panel is one TS2322 at `heading`;
- definition on `App` lands in `App.svelte` (two spots, svelte2tsx's value and type), on `Panel` in `Panel.ucf`.

**`emitSvelteTypes({root: <copy>})`**, `ts` left to the default:
- it writes exactly one `.ucf/svelte/components/<path>.ucf.d.ts` per copied `.ucf` file whose `<svelte>` block tsserver serves a script for (`getTypesScript`), and none for the others: `svelte/errors/UnclosedBrace.ucf` and `invalid/StyleInSvelte.ucf` get none, as svelte2tsx cannot read them;
- `Panel.ucf.d.ts` default-exports `import("svelte").Component<…>` with `heading: string`;
- a JS-block fixture's declaration has typed props, not `{}`;
- with `Panel.ucf`'s markup broken (an unclosed `{`), a second run keeps its last declaration;
- after removing `<svelte>` from the copy's `Card.ucf`, a second run deletes `Card.ucf.d.ts`.

**`emitSvelteTypes` edge cases**: a relative `root` and `outDir` resolve; `outDir` as the root writes beside the sources and leaves a `node_modules` `*.ucf.d.ts` alone; a block importing `./Plain.svelte` beside a `Plain/` folder still gets its declaration; a project with no `typescript` gets the "could not find typescript" error (child process, `NODE_PATH` unset).

**Our language server**, from source, `tsdk: TSDK`:
- two saves sent at once log one `wrote <n> Svelte declarations` line;
- saving `Card.ucf` with its `<svelte>` block removed deletes `Card.ucf.d.ts`;
- in a multi-root workspace (`<copy>`, `<copy>/components`), the output lands under the deepest folder;
- with no tsdk, a save writes nothing and logs nothing;
- in a project with no Svelte, a save logs the `no Svelte declarations for <root> (…could not find svelte…)` warning, and the next save does again.

**svelte-language-server over LSP**, workspace `apps/svelte-vite`, on `src/App.svelte`:
- before any emit, pulled diagnostics are exactly TS2307 at each `.ucf` import (no vite.config error);
- then our server's save writes the declarations, then `didChangeWatchedFiles`;
- then App.svelte has no diagnostics, hover on `<Panel` shows `Component<`;
- an unsaved `heading={1}` is one TS2322 at `heading`.

**svelte-check**:
- before the emit: fails, with 2307 on the `.ucf` imports (this proves it reads the declarations);
- after `emitSvelteTypes`: exit 0, no error, no warning;
- with the copy's `App.svelte` saved with `heading={1}`: exit 1, one error, at that line and column, "not assignable".

### Other test files

- **`editor/imports.spec.ts:11-23`**: a third setup, "our plugin beside Svelte's", `[PLUGIN, SVELTE_PLUGIN]`, rows = every non-vue row plus `src/Gallery.svelte`. Gallery checks: no error, definition on `Card.ucf`, binding `Card` is `Component` (the `SVELTE_BINDINGS` entry). The first two setups keep filtering `.svelte` rows out. The "every svelte row has its binding" check covers the new setup.
- **`editor/bundle.spec.ts`**: a new describe, "the bundled server writes Svelte declarations on save". `dist/server.cjs` on a `copyApp` copy, `tsdk: TSDK`, `didSave` on `Panel.ucf`. The written files are byte for byte what `emitSvelteTypes` from source writes for the same root, so svelte2tsx ran with the tsdk's TypeScript and the shipped shims.
- **`editor/vsix.spec.ts`**: unchanged. `dist/server.cjs` is still one file.

## Docs

- **`publicdocs/05-editor-setup.md`**:
  - Intro: `.svelte` files too.
  - New section "Svelte Files": install Svelte for VS Code beside ours, either order. `.ts` files get both plugins. On save of a `.ucf` file with `<svelte>`, our extension writes `.ucf/svelte/<same path>/Card.ucf.d.ts`. Add `"rootDirs": ["./src", "./.ucf/svelte/src"]` and `.ucf/` to `.gitignore`.
  - For svelte-check in CI, run `emitSvelteTypes` first (a `node -e` one-liner). A Tip says declarations are as fresh as the last save.
  - Follows `publicdocs/AGENTS.md`.
- **`docs/spec.md:331`** (risk "Our TypeScript plugin inside other editors' setups"): Svelte's language server and svelte-check never load tsserver plugins, so `.svelte` files read declarations our language server writes on save (`emitSvelteTypes`, found through `rootDirs`). In tsserver, ours loads beside `typescript-svelte-plugin` in either order (tested in M5).
- **`docs/plan.md:153`**: `.svelte` importers in Svelte's editor and `svelte-check` read those declarations. `Card.ucf.svelte.ts` serves tsserver.
- **`docs/architecture.md`**:
  - `:85` hosts row: the language server also writes Svelte declarations on save.
  - `:108` add one bullet on `.svelte` importers.
  - `:109` packaging: the server bundle's svelte2tsx gets the tsdk's TypeScript and `svelte-types/`.
  - Graphic `docs/assets/src/language.html`: an importer row `Page.svelte → .ucf/svelte/Card.ucf.d.ts, written on save`. Rendered with `pnpm devx docs-images`, HTML + PNG committed together.
- **Milestone doc**:
  - 5.11 Test text matched to what shipped: the wrong-prop page is the copy's `App.svelte`, plus the save path and the bundle check.
  - `- Status: done`.
  - Hands-to-later: `startServer(options)` and `ServerOptions` for M7.

## Decisions

- Q1, stale declarations: a `*.ucf.d.ts` whose `.ucf` file is gone or has no `<svelte>` block is deleted (a removed block must not keep typing its `.svelte` importers).
- Q2, the bundled server: a new `packages/vscode/src/server.ts` entry calls `startServer({svelteTypesRoot, onTypeScript})`, as `src/typescriptPlugin.ts` does for the plugin.
- Q3, the vite config: `svelte-vite` imports `@multifront/vite` through a computed specifier, as `sveltekit-src` does.

## Fuzzing

None in the milestone for this step. No cheap oracle beyond the per-fixture emit check above.

## Out of scope

- Markup completions, `mf-tsc` (M7).
- Writing declarations from the Vite dev server (the milestone's open question stays open).
- Emitting only the saved file (whole-root emit, about 2 s on all fixtures).
- Svelte LS features beyond types of `.ucf` imports.

## Done when

- Every test above passes here and in CI (`check` and `svelte-floor`), and the CI log shows `svelte-editor-setup.spec.ts` and the new `imports.spec.ts` setup running, not skipped.
- `pnpm devx check` is green.
- Spec, plan, architecture + graphic, the public page and the milestone doc are updated.
- This todo is moved to `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
