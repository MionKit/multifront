---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 6
step: 6.7
---

# Milestone 6.7: each target's `package.json`, and packing

## Problem

After 6.1 to 6.6, `buildLibrary()` writes `dist/react` and `dist/vue` with JS, CSS and `.d.ts`, but no `package.json`,
README or LICENSE: the folders cannot be packed or installed. The library's own manifest is read only for its `name`
(`libraryName()`, `packages/vite/src/library/build.ts:73`).

Checked on this host with throwaway copies outside the repo:

- A hand-written manifest of the planned shape in the built `dist/react` and `dist/vue` packs with real
  `pnpm pack --pack-destination <dir> --json` (the JSON gives the tarball path), also from a folder inside a pnpm
  workspace tree like `packages/e2e/.tmp/`.
- `publint` 0.3.24 directly on each tarball (`publint <file>.tgz --strict`): "All good!", exit 0.
- `attw` 0.18.5 on each tarball with `--profile esm-only`: exit 1, only because of `"./styles.css"`. attw checks type
  resolution and a CSS file has none, so any `.css` subpath is NoResolution (the `./*.css` wildcard is not checked).
  With `--exclude-entrypoints styles.css` both tarballs pass.
- Pins old enough for `minimumReleaseAge`: `publint` 0.3.24 (2026-08-19; 0.3.25 is too new), `@arethetypeswrong/cli`
  0.18.5 (2026-07-09).

## Plan

1. **Types**, `packages/vite/src/types.ts`, beside `LibraryTypesJob`:

   ```ts
   /** What `writePackageJson()` gets; posix paths, output names without `.js`. */
   export interface LibraryPackageJob extends Pick<LibraryResult, 'outDir' | 'packageName'> {
     root: string; // library folder: its README.md and LICENSE
     manifest: Record<string, unknown>; // the library's package.json, {} when it has none
     peers: Record<string, string>;
     index?: string; // 'index'
     components: string[]; // 'Card', 'forms/Field'
   }
   ```

2. **`packages/vite/src/library/packageJson.ts`** (new): `writePackageJson(job): Promise<void>` writes
   `<outDir>/package.json` (2-space JSON, final newline), keys in this order:
   - `name` = `job.packageName` (`packages[target].name`, default `<name>-<target>`, as build.ts already computes).
   - `version`, `description`, `license`, `author`, `repository`, `homepage`, `keywords` copied from `manifest`, each
     only when present and not `null`.
   - `type: "module"`, `sideEffects: ["*.css"]`.
   - `types: "./index.d.ts"` only when there is an index and its `.d.ts` was written.
   - `exports`: `"."` when there is an index, then one subpath per component in source order (`"./Card"`,
     `"./forms/Field"`), each `{types: "./Card.d.ts", default: "./Card.js"}`, with `types` only when that `.d.ts`
     exists (`dts: false` → `{default}`). Then `"./styles.css"`, `"./*.css"` and `"./package.json"`. 6.2's CSS step
     always writes `styles.css`, empty when no component has a style, so both CSS entries always point at a file.
   - `peerDependencies` = `job.peers` (row ranges merged with `packages[target].peers`). No `dependencies`,
     `devDependencies`, `scripts`, `main`, `files`, `private`.
   - Copies `README.md` and `LICENSE` from `root` when present.
   - A `.d.ts` is checked with `existsSync`; output names come from `outputName()` (`names.ts`).

3. **`build.ts`**: `libraryName()` becomes `libraryManifest(root): Promise<Record<string, unknown>>` (same errors:
   missing or `null` → `{}`, unparsable → "cannot read …"). `TargetJob` extends `LibraryPackageJob` (so gains
   `manifest`, `index` and `components`, as output names). `buildOne` calls `writePackageJson(job)` last, after `emitTypes`, before `filesIn`, so `LibraryResult.files`
   lists `package.json`, `README.md`, `LICENSE` too.

4. **Fixture**: `packages/e2e/fixtures/library/package.json` gains `repository` and `homepage`, so every copied field
   is checked.

5. **Root devDependencies** (test tools at the root): `publint` 0.3.24, `@arethetypeswrong/cli` 0.18.5.

6. **Consumer area starts**: drop `packages/e2e/consumer/.gitkeep`. New `packages/e2e/consumer/lib/pack.ts`:
   - `packLibrary(outDir): Promise<Partial<Record<Target, string>>>`: per `<outDir>/<target>/` with a
     `package.json`, real `pnpm pack --pack-destination <outDir> --json`; returns the tarball paths.
   - `tarFiles(tarball)` (real `tar -tzf`), and `publint(tarball)` / `attw(tarball)` running the root-installed bins
     through `process.execPath`, resolving with `{code, output}`. publint exports no `package.json`, so its bin is
     found beside its resolved main file; attw's from its `package.json`.

## Decisions

- attw runs on the tarball itself: `attw <tgz> --profile esm-only --exclude-entrypoints styles.css
  --no-definitely-typed`. `--pack` would re-pack the folder with npm; the CSS exclude drops only a file with no types;
  `--no-definitely-typed` keeps it off the registry. (Orchestrator, rule 1.)
- The row's extra export `conditions` field comes in 6.8 with the svelte row and its test, not here. (Orchestrator,
  rule 4.)
- `packLibrary` returns `Partial<Record<Target, string>>`: only built targets are packed. (Orchestrator, rule 4.)
- Built, not planned: `styles.css` and `./*.css` are always exported. The plan made them conditional, but 6.2 always
  writes `styles.css` (empty without styles), so the condition could never be false.
- No new CI job: these tests need only `pnpm` and `tar` in the `check` job. The consumer job (build and pack once,
  shared pnpm store) comes with 6.10, whose fresh-app installs first need it.

## Tests

`packages/e2e/consumer/pack.spec.ts`, each build in its own fresh temp `outDir` (`buildFixtureLibrary()` /
`withEditedLibrary()` from `build/lib/library.ts`):

- **Tarball list** of react and vue (`tar -t`) equals `package/` + every `LibraryResult.files` entry: `Card.js`,
  `Card.d.ts`, `Card.css`, `styles.css`, `index.js`, `index.d.ts`, `package.json`, `README.md`, `LICENSE` among them,
  no `.ucf`, no `node_modules`.
- **publint** `--strict` on each tarball: exit 0, "All good!".
- **attw** with the decided flags on each tarball: exit 0, output shown on failure.
- **Manifest shape**: react and vue `package.json` equal a full expected object, key order included.
- **Overrides and dropped fields**: an edited copy whose `package.json` adds `dependencies`, `devDependencies`,
  `scripts`, `main`, `files`, `exports`, built with `packages.react = {name: '@acme/ui-react', peers: {react:
  '^19.1.0'}}`: name and overridden peer land, `react-dom` keeps its default, none of those fields are written;
  without `README.md` / `LICENSE` neither is written. With `dts: false` there is no top-level `types` and `"."` is
  `{default}`; a `description: null` is not copied.
- **No library manifest**: a copy without `package.json`, named through `packages.react.name`, gets exactly `name`,
  `type`, `sideEffects`, `types`, `exports`, `peerDependencies`. In `build/library.spec.ts`, a `package.json` holding
  `null` fails with the "has no name" error.
- **Minimal library**: `plain/Plain.ucf` (React, no style), `src: 'plain'`, `dts: false`: `exports` is exactly
  `"./Plain": {default}` + the two CSS entries + `"./package.json"`, no top-level `types`, and the tarball passes
  publint and attw.

Where: this host and CI's `check` job (and the floor jobs), inside `pnpm devx test`. Needs `pnpm` and `tar`
(ubuntu-latest, `pnpm/action-setup`) and the two root devDependencies. No network.

## Docs

- `docs/architecture.md`, library-build bullet: one sentence on `package.json` writing and README / LICENSE copy.
- `docs/milestones/m6-library-build.md`, 6.7: `- Status: done`, `packLibrary`'s type, the attw call, a note that 6.8
  adds the row's `conditions`. `docs/milestones/m7-full-editor-support.md` does not name `packLibrary`.
- `docs/spec.md`, `docs/plan.md` already say it. No `publicdocs/` page describes the library build yet.

## Fuzzing

Not a candidate: a small deterministic map, no text rewrite, no offsets. publint, attw and pnpm pack are the oracles.

## Out of scope

- The svelte row, its `svelte` condition and `"svelte"` field (6.8). `mf-build` (6.9).
- Installing tarballs into apps and the consumer CI job (6.10). Publishing and versioning.

## Done when

- `buildLibrary()` writes `package.json`, `README.md`, `LICENSE` into `dist/react` and `dist/vue` as above.
- `packages/e2e/consumer/pack.spec.ts` passes here and in CI.
- `pnpm devx check` passes.
- Architecture line and milestone step updated; todo moved to `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
