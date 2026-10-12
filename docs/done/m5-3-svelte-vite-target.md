---
type: feature
spec: full-plan
status: done
created: 2026-10-12
milestone: 5
step: 5.3
---

# Milestone 5.3: Vite serves the Svelte id and hands it to plugin-svelte

## Problem

`load` already answers `/abs/X.ucf.svelte.svelte` with `buildTarget(split, ctx, 'svelte')` through the cached split
and `this.addWatchFile` (`packages/vite/src/index.ts:199-206`; `virtualTarget` in `ids.ts:21-24` covers svelte) since
5.2. Missing:

- Nothing checks for plugin-svelte. Without it a svelte pick fails deep in Rolldown with `[PARSE_ERROR]` on the
  `.svelte.svelte` id (`e2e/build/react-target.spec.ts:144-148` pins that today).
- Nothing notices when plugin-svelte is there but skips our id (a user `exclude` matching it): the raw `.svelte` code
  reaches Rolldown, same unclear failure.
- `@multifront/vite` has no svelte peers, the repo has no `@sveltejs/vite-plugin-svelte`, CI has no `svelte-floor`
  job, and no test runs a real Vite + plugin-svelte build of a `.ucf` file.

Checked (plugin-svelte 7.3.0 and 7.0.0 tarballs, svelte 5.57.0):

- plugin-svelte returns a marker plugin named exactly `vite-plugin-svelte` (`src/index.js`, same in 7.0.0); its
  `exclude` takes RegExps.
- plugin-svelte 7.0.0 and 7.3.0 both declare peer `svelte ^5.46.4`. Under the repo's `strictPeerDependencies`, a
  `svelte ^5` floor (5.0.0) cannot install beside plugin-svelte 7.
- Compiled Svelte always imports `svelte/internal/client` or `svelte/internal/server`, even for an empty component.
  Our post plugins run before Vite's import analysis, so the bare specifier is still there.
- Svelte's client source map does not map text inside the `$.from_html` template string; it maps the element and
  `{expr}` lines. The map test checks lines, not the marker's own spot.
- plugin-svelte passes `this.getCombinedSourcemap()` to `svelte.compile`, which merges our `load` map into its own; Vite
  (and Rolldown) then apply our map a second time and every segment is lost (found while building: zero mappings into
  `Panel.ucf` in dev and in the build).
- `$state(start)` on a prop warns `state_referenced_locally`; `$state(untrack(() => start))` does not.
- A svelte-pick check in `resolveId` breaks the imports app's dev-server rows that pick svelte (`src/lazy.ts`,
  `custom-importers/widget.ts`, …) unless their configs get `svelte()`. `imports.spec.ts:19` already says
  "Milestone 5 adds `svelte()` to the configs".

## Decisions

Orchestrator's answers to the plan questions:

1. Svelte peer floor: `svelte ^5.46.4` and `@sveltejs/vite-plugin-svelte ^7.0.0` as optional peers of
   `@multifront/vite`, core's `svelte` peer raised to `^5.46.4`: the tested floor must be the claimed floor
   (plan.md "Framework versions"). Floor dry-run before pushing; a failing test at 5.46.4 raises the floor, with why.
   Shipped: the dry run failed below 5.55.6 (5.55.5: the server render drops `<ui.Child>` read from `$derived`;
   older releases also write other hydration markers), so both peers are `^5.55.6`. Everything passes on 5.55.6 with
   plugin-svelte 7.0.0.
2. Panel fixture: only what 5.3 asks. Panel gains its `<svelte>` block (rendering `PanelItem`) and the
   `<style module lang="scss">`; its `<vue>` and `<react>` blocks stay as they are (5.8 and the exit test change them
   for parity). PanelItem.ucf gets all three target blocks.
3. Prop name: Panel keeps M1's `heading`; milestone 5.9 and 5.10 say `heading` where they name Panel's prop.
4. Error wording: users see "framework" (milestones README). "the svelte framework needs
   @sveltejs/vite-plugin-svelte in your Vite plugins". M4's `VUE_PLUGIN_MISSING` breaks the same rule: reworded to
   "the vue framework needs …" in its own commit, its tests updated.

## Plan

### `@multifront/vite`

1. New `packages/vite/src/svelteTarget.ts`, beside `vueTarget.ts`:
   - `hasSveltePlugin(plugins)`: a plugin named `vite-plugin-svelte` (plugin-svelte's marker) is there.
   - `SVELTE_PLUGIN_MISSING = 'the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins'`.
   - `composeSveltePlugin(config)`, called from `configResolved` (after plugin-svelte's own, which sets up its
     compile, and before its compile plugin's): wraps the `vite-plugin-svelte:compile` plugin's `transform.handler` so
     that for our ids its context's `getCombinedSourcemap` returns `null`. The compiler then maps to our built code and
     Vite applies our `load` map once. Guarded against a second `configResolved` on the same instance.
   - `svelteCompiledPlugin(hasPlugin): Plugin`, `multifront:svelte-compiled`, `enforce: 'post'`, transform filter id
     `/\.ucf\.svelte\.svelte$/`: code with no `from 'svelte/internal/(client|server)'` import → with no plugin-svelte
     (a dev URL of the id skips the import's check) `${id}: ${SVELTE_PLUGIN_MISSING}`, else `this.error(`${id}: @sveltejs/vite-plugin-svelte did not compile this module; its include and exclude options
     must let ids ending in .ucf.svelte.svelte through`)`.
2. `index.ts`:
   - `configResolved` calls `composeSveltePlugin(resolved)`.
   - `resolveId`, after the missing-block check: target svelte and no `hasSveltePlugin(config.plugins)` (asked there,
     as the Vue check is) →
     `this.error(importErrorMessage(path, from?.fileName, `${SVELTE_PLUGIN_MISSING} (it compiles ${id})`))`, naming
     the import, its importer and the `.svelte.svelte` id. The scan path is unchanged (it sets svelte picks aside first).
   - Returned array: `[pre, vueHmr, vueImporters, svelteCompiledPlugin(() => hasSveltePlugin(config.plugins)), attributesPlugin(options)]`. The check runs
     before the attribute rewrite, which would otherwise read raw markup first.
   - `load` unchanged: the test proves it serves the id and watches the `.ucf` file.
3. `packages/vite/package.json`: optional peers `"svelte": "^5.55.6"`, `"@sveltejs/vite-plugin-svelte": "^7.0.0"`;
   pinned devDependencies `svelte` 5.57.0, `@sveltejs/vite-plugin-svelte` 7.3.0. Root devDependency
   `@sveltejs/vite-plugin-svelte` 7.3.0. Lockfile through pnpm.
4. `packages/core/package.json`: `svelte` peer `^5.0.0` → `^5.55.6`.
5. `VUE_PLUGIN_MISSING` (`vueTarget.ts:22`) says "the vue framework needs @vitejs/plugin-vue in your Vite plugins";
   `react-target.spec.ts` and `vue-compose.spec.ts` expect the new text. Own commit.

### Floor job

6. `scripts/lib/peer-floor.mjs` `FLOOR_PEERS`: `svelte: {peers: ['svelte', '@sveltejs/vite-plugin-svelte'], follow: {}}`.
7. `.github/workflows/ci.yml`: `svelte-floor` job, a copy of `vue-floor` running `pnpm devx peer-floor svelte`.
8. Done before pushing: the floor on a throwaway worktree in the scratchpad (`CI=1 pnpm devx peer-floor svelte`, then
   `pnpm devx test`). A failing test at 5.46.4 → floor moves up to the lowest svelte where every test passes; ranges,
   docs and PR say which and why.

### Fixtures

9. `fixtures/components/Panel.ucf` gains, after its existing blocks, a `<style module lang="scss">` (an SCSS
   variable, `.title`) and a `<svelte>` block: `heading` and `children?: Snippet` props,
   `<section class="panel" data-marker="panel-svelte-marker"><h3 class="heading {$style.title}">{heading}</h3>
   <PanelItem label="…" />{@render children?.()}</section>`, importing `./PanelItem.ucf`. Vue and React blocks unchanged.
10. New `fixtures/components/PanelItem.ucf`: `<vue>`, `<react>`, `<svelte>` blocks, each
    `<p class="item" data-marker="panel-item-<fw>-marker">{label}</p>` with prop `label: string`, plus
    `<style scoped>` with `.item`.
11. New `<svelte>` blocks, Svelte copies of the existing ones: `Counter.ucf` (`$props`,
    `$state(untrack(() => start))`, `class={$style.button}`, `onclick`), `imports/Icon.ucf`
    (`aria-label="icon-svelte-marker"`), `imports/UsesIcon.ucf` (imports `./Icon.ucf`, `uses-icon-svelte-marker`).
    `vue/CounterCrlf.ucf` (Counter's CRLF twin) gets the same block. `build/hmr.spec.ts`'s "a new `<svelte>` block"
    row becomes "`<svelte>` text (its module never loaded)", as Counter now has one, and a new row removes the whole
    block ("a removed `<svelte>` block"), so a target block present on one side of an edit stays covered.
    Core's "builds every other `<svelte>` block, and Svelte compiles it" test (`core/test/blocks/svelte.spec.ts:148`)
    picks them all up.
12. New app `fixtures/apps/svelte-vite/`: `vite.config.ts` (`plugins: [svelte(), multifront()]`), `index.html`,
    `src/main.ts` (`mount()` of `Panel` and `Counter`, each imported `with {framework: 'svelte'}`).
13. Tests and snapshots that list every fixture get PanelItem rows and the new Panel / Counter values (hand-written
    expectations, not loosened): core `split.spec`, `context.spec`, `styles.spec`, `react/scope.spec` and their file
    snapshots; editor `virtualCode/Panel.ucf.react.tsx`; any other list the full run flags. `react-target.spec.ts`
    `OTHER_MARKERS` and `vue-imports.spec.ts`'s absent-marker list gain `icon-svelte-marker`, `uses-icon-svelte-marker`.
14. `fixtures/apps/imports/vite.config.ts` and `custom-importers/vite.config.ts` gain `svelte()`; their svelte rows
    still resolve to the `.svelte.svelte` id. The `.svelte` importer rows stay filtered out until 5.4.

## Tests

All on this host and CI `check` (real Vite 8.2.2, plugin-svelte 7.3.0, svelte 5.57.0); the whole suite again in
`svelte-floor`.

- `packages/e2e/build/svelte-target.spec.ts`, on `apps/svelte-vite`:
  - Build (`sourcemap: true`): the chunk holds the `.svelte.svelte` ids of `Panel`, `PanelItem` (reached from Panel's
    block with no attribute) and `Counter`, and Svelte's `internal/client` runtime; those modules' rendered code has no
    `<script`, `{@render`, `$props()` or `{heading}`; the Svelte markers are in the bundle; Panel's compiled template
    carries `data-v-<ctx.scopeId>` (production id).
  - CSS: one asset; each `ctx.styles` selector of Panel, PanelItem and Counter exactly once; every class-map value in
    the JS; no `svelte-<hash>` class in the CSS.
  - No `panel-item-vue-marker` or `panel-item-react-marker` in JS or CSS (Panel's own Vue and React blocks carry no
    marker, and stay unchanged).
  - Source map: segments with source `components/Panel.ucf` exist, all on lines of Panel's `<svelte>` block, one on
    the `{heading}` line.
  - Dev server (`withDevServer`, cache in a temp dir: plugin-svelte pre-bundles svelte): `main.ts` imports Panel's
    `.svelte.svelte` URL; transforming it gives compiled code (`svelte/internal/client`) whose map points into Panel's
    `<svelte>` block; its module node imports the real `Panel.ucf` (the `addWatchFile` edge).
  - The same dev server's SSR environment serves Panel compiled for the server (`svelte/internal/server`), mapped the
    same way.
  - A restart with the same plugin instances keeps one wrapper around plugin-svelte's compile handler.
  - A dev request for the Svelte id with no plugin-svelte fails with `<id>: the svelte framework needs
    @sveltejs/vite-plugin-svelte in your Vite plugins` (`multifront:svelte-compiled` asks for the plugin before
    blaming its include and exclude options).
  - `{configFile: false, plugins: [multifront()]}`: fails with `../../../components/<Panel|Counter>.ucf (imported by
    <main.ts>): the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins (it compiles
    <abs>/<Panel|Counter>.ucf.svelte.svelte)`. Both resolve in parallel, so either fails first: the test reads which.
  - `svelte({exclude: [/\.ucf\.svelte\.svelte$/]})`: fails with `<abs>/Panel.ucf.svelte.svelte:
    @sveltejs/vite-plugin-svelte did not compile this module…`.
- `react-target.spec.ts`: "fails a svelte pick without plugin-svelte" expects our message with the importer and the
  `AllBlocks.ucf.svelte.svelte` id, in place of `[PARSE_ERROR]`.
- `packages/e2e/devx/peer-floor.spec.ts`: `floorOverrides('svelte')` is
  `{svelte: '5.55.6', '@sveltejs/vite-plugin-svelte': '7.0.0'}`; refusals say `knows react, vue, svelte`.
- Proof of infra: PR or `PUSHED` message quotes `svelte-floor` log lines (`peer-floor: svelte 5.55.6 …`, the
  `svelte-target.spec.ts` tests running).

## Docs

- `docs/plan.md` "Framework versions": the Svelte range (`svelte ^5.55.6` and why, plugin-svelte `^7.0.0`) replaces
  "comes with its milestone"; the milestone 5 summary names the source map composition and the `svelte-floor` job.
- `SETUP.md`: peer-floor lines name svelte and the `svelte-floor` job.
- `docs/milestones/m5-svelte-target.md`: 5.1 core peer `^5.55.6`; 5.3 text with the exact ranges, messages, the
  source map composition and the fixture scope, `- Status: done`; 5.9 and 5.10 say `heading` for Panel's prop. `m4-vue-target.md` quotes the Vue message: new wording.
- `publicdocs/01-getting-started.md`: rows `svelte` `^5.55.6` and `@sveltejs/vite-plugin-svelte` `^7.0.0` in the
  package table (it lists the plugin's peers). `publicdocs/04-imports.md`: the plugin-vue note also names
  plugin-svelte for svelte picks. Full Svelte pages: the milestone's docs writer.
- No `docs/architecture.md` change (no structure change).

## Fuzzing

None: the milestone puts Svelte fuzzing in 5.7; no cheap oracle beyond the build tests here.

## Out of scope

- `.svelte` importers and their imports rows (5.4). HMR, plugin-svelte's `hotUpdate` on the bare id (5.5).
  SSR, SvelteKit (5.6). Forwarding and Panel's Vue / React parity (5.8, exit test). Types and editor (5.9 to 5.11).

## Done when

- `pnpm devx check` green; the new spec passes here.
- CI `check`, `react-floor`, `vue-floor`, `svelte-floor` green, the log showing the svelte tests ran.
- Milestone docs, plan.md, SETUP.md and the two public pages match what shipped; this todo reconciled and moved to
  `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
