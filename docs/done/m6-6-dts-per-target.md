---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.6
---

# Milestone 6.6: `.d.ts` per target

## Problem

After 6.1 to 6.5, `buildLibrary()` writes `dist/react` and `dist/vue` with JS and CSS but no types: a consumer importing
`@mf-fixture/ui-react` gets implicit `any` (TS7016 under `strict`). The `dts` option exists but does nothing yet
(`packages/vite/src/types.ts:49`).

Checked on this host before planning, with throwaway copies outside the repo:

- `getTypesScript(file, source, 'react', {compiler})` gives a `.tsx` script with the 6.5 root props and `declare const
  $style`. Real `tsc` 6.0.3 emits a clean `Button.d.ts` from it, `ref?: Ref<ComponentRef<'button'>>` included.
- `buildTarget(split, ctx, 'vue')` gives the SFC code (padded so offsets match the `.ucf` file) with the root
  `<style module>` blocks. `vue-tsc` 3.3.11 (peer `typescript >=5.0.0`, released 2026-08-21, the same version as the
  `@vue/language-core` we already pin) runs on TypeScript 6.0.3 and emits self-contained `Card.vue.d.ts` files. So the
  "vue-tsc and TypeScript 6" risk does not happen: no second TypeScript pin.
- **A stage under `node_modules/` needs every reached file as a root.** tsc treats a file it reaches only by import inside
  a `node_modules` path as an external library and writes no `.d.ts` for it: `utils/cx.ts` (imported by `Card`) got no
  `utils/cx.d.ts`. A type-only import (`import type {Props} from './types.js'`) is not a module of the JS build, so the
  build alone cannot list it. Both `tsc --listFilesOnly` and `vue-tsc --listFilesOnly` print every file the program
  reaches, `.vue` files included: a listing pass finds them.

## Decisions

- Orchestrator: the stage stays in `<root>/node_modules/.cache/multifront/` (never shows in a user's repo, editor or
  watcher if a run is killed). Each tool runs once with `--listFilesOnly` to find every staged file it reaches, then the
  real run takes all of them as roots. No `.gitignore` line.
- Orchestrator: `_virtual/` JS files get no `.d.ts`: internal helpers no `.d.ts` imports and no export reaches. The 6.6
  Deliverable line says so.
- Orchestrator, reversed after review: the missing optional-peer error is tested in this PR, not deferred to a todo.
  The first answer (no test now, a guidelines todo) broke "the step whose test first needs a piece builds it" (milestones
  README, Test infrastructure) and AGENTS.md "Missing test infra is built, never skipped around". The smaller route
  worked, so nothing is packed: the three tools resolve from the library root (like `loadVueCompiler(root)`, and plan.md
  "the user's versions are always the ones in use"), and a fixture copy outside the workspace without one reaches the
  error. The todo is deleted.
- Orchestrator: specifiers are parsed with oxc through Vite's `parseAst` (the parser Rolldown ships): no new dependency.
  The step text says "oxc (Vite's `parseAst`)".

## Plan

### Types and the row hook (`packages/vite/src/types.ts`)

- New `LibraryTypesJob`:
  ```ts
  /** What a row's `emitTypes()` gets: paths are posix, `modules` relative to `src`. */
  export interface LibraryTypesJob extends Pick<LibraryResult, 'target' | 'outDir'> {
    root: string; // library folder
    src: string;
    modules: string[]; // the .ucf files and plain modules the JS build wrote: 'Card.ucf', 'utils/cx.ts'
  }
  ```
- `LibraryTarget` gains `emitTypes(job: LibraryTypesJob): Promise<void>` (required: the 6.8 svelte row gives its own).
- The `LibraryOptions.dts` comment: `// default true: a .d.ts beside every JS file`.

### Build wiring (`packages/vite/src/library/build.ts`)

- `buildOne` (`:128`) adds a small plugin that collects, in `generateBundle`, every chunk's real module ids inside `src`
  (through `fileOf`, so `Card.ucf?…&type=style` and `Card.ucf.react.tsx` count as `Card.ucf`) into a sorted `modules`.
- After `await build(…)` (`:168`), before listing the written files (`:169`; `writtenFiles` moved to `names.ts` as
  `filesIn`, shared with the types step): when `options.dts !== false`,
  `row.emitTypes({target, root, src, outDir, modules})`. So `LibraryResult.files` lists the `.d.ts` files too.

### The types step (`packages/vite/src/library/dts.ts`, new)

Exports `emitReactTypes(job)` and `emitVueTypes(job)`; `targets.ts` imports them statically (the optional peers are
loaded lazily inside) and sets them as the react and vue rows' `emitTypes`.

1. **Optional peers, loaded only here, from the library root**: `createRequire(<root>/package.json).resolve(…)`, like
   `loadVueCompiler(root)`. `typescript` (React) or `vue-tsc` (Vue) through `'<name>/package.json'`, the bin from its
   `bin` field; `@multifront/language-tools` (React) resolved the same way, then a dynamic `import()` of its file URL.
   A missing one throws
   `buildLibrary: the <target> types need <name>; install it, or set dts: false`.
2. **Stage**: `mkdtemp(<root>/node_modules/.cache/multifront/types-<target>-)`. Copy every file of `src` there, same
   layout, except `.ucf` files. Each `.ucf` file in `job.modules` becomes:
   - React: `Card.tsx`, the code of `getTypesScript(file, source, 'react', {compiler: loadVueCompiler(root)})`.
   - Vue: `Card.vue`, the code of `buildTarget(split, await createBuildContext(split, {root, compiler, production: true}),
     'vue')`.

   Removed in `finally`, whatever happens.
3. **Specifier rewrite**, oxc (Vite's `parseAst`) and MagicString, never a regex. A walk over the AST finds the string
   literal source of `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`, `ImportExpression` and
   `TSImportType`. Only relative specifiers ending in `.ucf` change, matched by value: the whole literal is overwritten
   with `JSON.stringify(next)`, so an escaped specifier is rewritten too.
   - React: `.ucf` → `.js` in every staged script file.
   - Vue: `.ucf` → `.vue` in plain script files, and in a staged `.vue` file's `<script>` / `<script setup>` contents
     found with `compiler.parse` (offset by `loc.start.offset`, language from `lang`).
   - A file that does not parse stays as is: tsc reports it.
4. **Generated `tsconfig.json`** in the stage: `extends` `<root>/tsconfig.json` when it exists. With none, the defaults
   `target: es2022`, `module: esnext`, `moduleResolution: bundler`, `strict: true`, `skipLibCheck: true`. Always forced:
   `allowJs` (a plain `.js` module gets its `.d.ts`), `declaration`, `emitDeclarationOnly`, `declarationMap: false`, `sourceMap: false`, `noEmit: false`,
   `composite: false`, `incremental: false`, `rootDir: "."`, `outDir` and `declarationDir` set to `job.outDir`; React also
   `jsx: react-jsx`. `include: []` so a parent `include` is not inherited.
5. **Listing pass**: `files` = the staged `job.modules` plus every staged `.d.ts`; run the tool with `--listFilesOnly`.
   Every listed file inside the stage becomes a root, compared against the stage's real path (tsc prints it past any
   symlink in the library root). A failing listing run throws the same mapped error as the real run, its file list
   dropped.
6. **Real run**: `files` = those roots. `spawn(process.execPath, [bin, '-p', 'tsconfig.json', '--pretty', 'false'],
   {cwd: stage})`. A non-zero exit throws `buildLibrary: the <target> types do not compile:` and the output, each
   `Card.tsx(9,14): error …` line as `src/Card.ucf: error …` (a position in the generated script is not one in the `.ucf`
   file); a plain file keeps its position, with its `src/` path. No stage path is left in the message.
7. **Vue, afterwards**: rename every converted component's `X.vue.d.ts` in `outDir` to `X.d.ts`; in every `.d.ts`, each relative `.vue`
   specifier that points at a converted component becomes `.js` (same walk, `lang: 'dts'`).

### Packages and repo

- `packages/vite/package.json`: optional `peerDependencies` `typescript: ^6.0.0`, `vue-tsc: ^3.3.11`,
  `@multifront/language-tools: workspace:*`; `devDependencies` `typescript: 6.0.3`, `vue-tsc: 3.3.11`,
  `@multifront/language-tools: workspace:*`.
- Root `devDependencies`: `vue-tsc: 3.3.11` (the e2e test runs it).
- `packages/vite/tsconfig.build.json`: reference `../language-tools/tsconfig.build.json`.

## Tests

All on this host and in CI's `check` job (`pnpm devx test`), again in the floor jobs. The only new tool is `vue-tsc`,
installed by `pnpm install`. No new CI infra.

Build area, `packages/e2e/build/library-types.spec.ts`. `beforeAll`: `buildFixtureLibrary()`, then copy
`fixtures/library-checks/` to `<outDir>/checks/` so its relative imports reach the built folders.

- Every `.js` file in `react/` and `vue/` outside `_virtual/` has `Name.d.ts` beside it; no `.d.ts` without a JS file, no
  `*.vue.d.ts`, nothing under `_virtual/`.
- No `.d.ts` has a `.ucf`, `.tsx` or `.vue` specifier (new `typeSpecifiersOf(file, code)` in `build/lib/library.ts`,
  oxc-parser with `lang: 'dts'`).
- Real `tsc --noEmit -p checks/tsconfig.react.json` exits 0 over `checks/react.tsx`: the index components, `Field` from
  `../react/forms/Field.js`, `Badge` from `../react/Badge.js`, right props; `Button` with `className`, `style` and a
  `useRef<HTMLButtonElement>` ref passes; under `// @ts-expect-error`: `<Card titel="x" />` and a `<div>` ref on `Button`.
- Real `vue-tsc --noEmit -p checks/tsconfig.vue.json` exits 0 over `checks/Check.vue`: `Card` with slot content,
  `Counter`, `Button` with an `(event: MouseEvent) => …` click handler, `VueOnly` from `../vue/VueOnly.js`;
  `<!-- @vue-expect-error -->` above `<Card titel="x" />`.
- Type errors fail the build, each on its own fixture copy, one framework per build: `const count: number = 'x'` in Card's
  `<react>` block, then in its `<vue>` `<script setup>`. The message names `src/Card.ucf` and `TS2322`, has no
  `node_modules/.cache` path; no stage folder is left.
- A type-only plain module gets its `.d.ts` (proves the listing pass): a copy with `src/types.ts` used through
  `import type` in Card's `<react>` block → `react/types.d.ts` exists, and the React check passes.
- The library's `tsconfig.json` is extended, our emit options win: a copy with
  `{"compilerOptions": {"noEmit": true, "declarationMap": true, "noUnusedLocals": true}}` builds, writes `.d.ts`, no
  `.d.ts.map`; with an unused local in Card's `<react>` block it fails with `TS6133` and `src/Card.ucf`.
- `dts: false` (React only) writes no `.d.ts`.
- Added after review: an error in a plain module (`src/utils/cx.ts`) keeps its position; a syntax error in a type-only
  module (only the listing run sees it) is named `src/types.ts(1,24)` with no stage or `node_modules` path; a plain
  `src/utils/upper.js` gets `utils/upper.d.ts`; an escaped `'./Ic\u006fn.ucf'` builds; a nested Vue component
  (`forms/Field.ucf` typing a prop with `typeof Icon`) gets `../Icon.js` in `vue/forms/Field.d.ts`.
- The missing peers, each in turn (`typescript` and `@multifront/language-tools` for React, `vue-tsc` for Vue): a copy of
  the fixture library in the OS temp dir (`copyLibraryOutside(without)` in `fixtures/index.ts`), its `node_modules`
  linking the repo's installed packages minus that one, built by `buildInFreshNode()` (`build/lib/library.ts`) in a
  fresh Node process without the `NODE_PATH` pnpm's bin shim sets. The message names the package, no stage is left.
  With all three missing and `dts: false`, and with all three present, the build passes.

New fixture `packages/e2e/fixtures/library-checks/`: `react.tsx`, `Check.vue`, `tsconfig.react.json`,
`tsconfig.vue.json` (options written out in full, each including only its check file).

The other library specs keep the default `dts: true`, so their builds also prove the types compile. What that took:

- `copyLibrary()` (`fixtures/index.ts`) no longer copies the fixture's `node_modules`: the stages of library builds running
  in parallel live there, and a copy taken mid-build carried them along.
- `library.spec.ts`, the `vite` option case: its alias `~` exists only in Vite config, which never reaches tsc (milestone
  risk), so that build sets `dts: false`. What it checks is unchanged.
- `library.spec.ts`, the `left-pad` peer case: the copy also gets `src/left-pad.d.ts` (`declare module 'left-pad'`), as a
  library with an untyped peer would, and its `cx` takes `(string | undefined)[]` as Badge passes an optional
  `className`. That also covers an ambient `.d.ts` of `src` as a root.

## Docs

- `docs/milestones/m6-library-build.md`: 6.6 text to what shipped (stage + listing pass, `emitTypes(job)` /
  `LibraryTypesJob`, "oxc (Vite's `parseAst`)", no `.d.ts` for `_virtual/`), then `- Status: done`. Risks: vue-tsc 3.3.11
  runs on TS 6; path aliases in the library tsconfig point at the real `src/`, not supported yet. "Hands to later
  milestones": `LibraryTypesJob`, `emitTypes`.
- `docs/architecture.md:100`: one sentence on the types step.
- `docs/plan.md:164` and spec 8 already say it. No `publicdocs/` change.

Shipped cost: the listing run adds about one tool start per target (the whole types step is about 2 s for React and 3 s
for Vue on the fixture).

## Fuzzing

None: each run spawns tsc or vue-tsc, and the checks over the fixture are the oracle.

## Out of scope

- Path aliases into `src` from the library tsconfig.
- `.d.ts` maps.
- Svelte types (6.8).
- `package.json` `types` / `exports` (6.7).

## Done when

- `buildLibrary()` writes a `.d.ts` beside every non-`_virtual` JS file in `dist/react` and `dist/vue`, with no `.ucf`,
  `.tsx` or `.vue` specifier.
- `library-types.spec.ts` passes on this host and in CI; `pnpm devx check` green.
- Milestone doc and architecture updated; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
