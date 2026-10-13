---
type: feature
spec: full-plan
status: done
created: 2026-10-13
milestone: 6
step: 6.9
---

# Milestone 6.9: the `mf-build` command and `multifront.config.ts`

## Problem

`buildLibrary(options)` and `defineLibrary(options)` exist in `@multifront/vite` (`packages/vite/src/library/build.ts:47`,
`:181`) but only from code: there is no command and no config file. The milestone's promise, `pnpm exec mf-build`
reading `multifront.config.ts` and writing `dist/react`, `dist/vue`, `dist/svelte`, does not work yet.

Checked on this host with a throwaway script in the gitignored `packages/e2e/.tmp/`:

- Vite 8's `loadConfigFromFile(env, file, root, 'silent', undefined, 'native')` loads a `multifront.config.ts` that
  does `import {defineLibrary} from '@multifront/vite'`; under `--conditions=source` Node resolves it to
  `packages/vite/src/`. Returns `{config}` in ~135 ms.
- The default `'bundle'` loader resolves every bare import with conditions `['node']` (`nodeResolveWithVite`), so it
  would import `packages/vite/dist/index.js`, which CI's `check` job has not built yet (Test runs before Build).
  `'runner'` uses the same `['node']` conditions.
- `loadConfigFromFile` only searches `vite.config.*` itself, so we pass the file we found.
- A full three-target build of the fixture library with types takes ~6.4 s in one process.
- `buildLibrary` already throws `buildLibrary: unknown framework 'angular'; use vue, react, svelte` (`build.ts:194`).

## Plan

### 1. `packages/vite/src/library/cli.ts` (new)

- `runMfBuild(args: string[]): Promise<number>`: returns the exit code, never calls `process.exit`.
- Flags through `node:util` `parseArgs`, strict, no positionals:
  - `--root <dir>`: relative to the cwd, default the cwd.
  - `--framework <name>`, repeatable (`multiple: true`): becomes `frameworks`, replacing the config's.
  - `--out-dir <dir>`: passed as `outDir`, so relative to the root like the config's `outDir` (and Vite's `--outDir`).
  - `--no-dts`: `dts: false`.
  - An unknown flag or a positional is an error (exit 1).
- Config: the first of `multifront.config.ts`, `.js`, `.mjs` that exists in the root, loaded through Vite's
  `loadConfigFromFile({command: 'build', mode: 'production'}, file, root, 'silent', undefined, 'native')`. None → flags
  only (`buildLibrary` defaults). A load failure → `mf-build: cannot load <file>: <message>`.
- Options: `{...config, root, ...flags}`; the CLI's root always wins over a `root` in the config.
- Output on stdout (`process.stdout.write`, `no-console`), one line per target in build order:
  `<target>: <n> files in <outDir relative to cwd> (<packageName>)`, plus `, skipped A.ucf, B.ucf` when any.
- Any error: `mf-build: <message>` on stderr, returns 1.

### 2. The bin (`packages/vite`)

- `packages/vite/bin/mf-build.js` (mode 100755, like language-tools' bin):

  ```js
  #!/usr/bin/env node
  import {runMfBuild} from '#cli';
  process.exitCode = await runMfBuild(process.argv.slice(2));
  ```

- `package.json`: `"bin": {"mf-build": "./bin/mf-build.js"}`, `"bin"` in `files`, and a private `imports` entry
  `"#cli": {"source": "./src/library/cli.ts", "default": "./dist/library/cli.js"}`: `dist/` once installed, `src/` in
  the workspace under `--conditions=source`. No new public subpath, no new index export.
- No lockfile change (workspace bins are not in `pnpm-lock.yaml`).

### 3. Fixture

- `packages/e2e/fixtures/library/multifront.config.ts`:
  `defineLibrary({packages: {react: {name: '@mf-fixture/ui-react'}, vue: {name: '@mf-fixture/ui-vue'}, svelte: {name: '@mf-fixture/ui-svelte'}}})`,
  importing `defineLibrary` from `@multifront/vite`. Existing library tests call `buildLibrary()` directly and never
  read it.

### 4. Docs

- `docs/plan.md`, "### 6. Library build": a bullet with `buildLibrary(options)` / `defineLibrary(options)`,
  `multifront.config.ts` (`.js`, `.mjs`) and `mf-build` with its four flags and exit code.
- `docs/spec.md` section 8: one line naming `mf-build` and `multifront.config.ts`.
- `docs/architecture.md`, library paragraph: one sentence on the `mf-build` bin loading the config through Vite's
  native config loader and calling `buildLibrary`. No graphic change.
- Milestone doc 6.9: shipped details (bin path, `#cli`, native loader, output line) and `- Status: done`.
- Public docs: the milestone's docs writer.

## Tests

Build area, new `packages/e2e/build/library-cli.spec.ts`. Runs on this host and in CI's `check` job through
`pnpm devx test`; no new infra (Node child processes, as `buildInFreshNode()` already does). Not on the Windows job.

Helper `runMfBuild(cwd, args)` in `packages/e2e/build/lib/library.ts`: reads the `bin['mf-build']` entry of the
installed `packages/e2e/node_modules/@multifront/vite/package.json` (the "JS entry, not the `.bin` shim" pattern of
`scripts/devx.mjs`, Windows-safe), runs `node --conditions=source <entry> ...args` in that cwd, resolves
`{code, stdout, stderr}`. The exit test reuses it.

Cases, each into its own temp folder (parallel-safe):

1. Fixture config, no flags, on a `copyLibrary()` copy with cwd = the copy: exit 0; `dist/{react,vue,svelte}/package.json`
   names `@mf-fixture/ui-react`, `@mf-fixture/ui-vue`, `@mf-fixture/ui-svelte`; stdout is exactly three lines (`vue`,
   `react`, `svelte`), each with the real file count on disk, `dist/<target>` and its skipped files (react
   `VueOnly.ucf`; svelte `Badge.ucf, VueOnly.ucf`).
2. Flags over config: a copy whose `multifront.config.ts` is
   `defineLibrary({packages: {vue: {name: '@acme/cards-vue'}}})`, run from the fixtures folder with
   `--root <copy> --framework vue --no-dts --out-dir <tmp>`: exit 0; only `vue/` written, named `@acme/cards-vue`
   (proves the `.ts` config and its `@multifront/vite` import loaded: not the default name); no `.d.ts`; stdout is exactly
   `vue: <n> files in <out dir relative to the cwd>/vue (@acme/cards-vue)`.
3. Unknown framework in a config: a copy with `multifront.config.ts` deleted and `multifront.config.mjs` =
   `export default {frameworks: ['angular']}`: exit 1, stderr has
   `mf-build: buildLibrary: unknown framework 'angular'; use vue, react, svelte`, empty stdout (also covers `.mjs`).
4. Repeated `--framework`: `--framework vue --framework angular` on the fixture: exit 1 with the same message for
   `angular` (both values reach `frameworks`), no out dir written.
5. Unknown flag `--outdir x`: exit 1, stderr names `--outdir`.

No fuzz test: no cheap oracle for a flag parser over one real build.

## Decisions

- D1: `configLoader: 'native'`, no `--config-loader` flag (orchestrator; `docs/milestones/README.md` "Fixture configs
  from source" row: fixture configs load natively so `@multifront/vite` comes from `src/`, never a stale `dist/`).
  A `.ts` config needs a Node that strips types (22.18+, 23.6+, 24+).

## Out of scope

- `--help`, watch mode, other flags. Publishing. Public docs.

## Done when

- Checked by hand: after `pnpm devx build`, the bin without `--conditions=source` runs `dist/` and builds the fixture.
- `pnpm exec mf-build` (the bin) in a library folder builds every target; `library-cli.spec.ts` passes;
  `pnpm devx check` passes; docs above updated; this spec moved to `docs/done/`.
