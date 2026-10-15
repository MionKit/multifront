---
type: fix
spec: guidelines
status: done
created: 2026-10-14
---

# Library types build fails on a type-only import from a .js or .jsx module

## Intent

A library component may type its props from a plain JavaScript module of `src`, through JSDoc
(`/** @typedef {{ title: string }} CardTitle */` in `src/title.jsx`, `import type { CardTitle } from './title.js'` in
both script blocks of `src/Card.ucf`). The React and Vue types builds then fail with
`TS7016 Could not find a declaration file for module './title.jsx' ... implicitly has an 'any' type`, an error in the
user's `.ucf` file for a library that is fine. A `.ts` module in the same place works.

## Direction

- Cause, to confirm: `emitTypes()` in `packages/vite/src/library/dts.ts` stages `src/` under the library's
  `node_modules/.cache/multifront/`. TypeScript loads a JavaScript file under `node_modules` only up to
  `maxNodeModuleJsDepth` (0), so a `.js` / `.jsx` module reached only by `import type` is never part of the program;
  a module with a chunk is a root and is unaffected. TypeScript files load at any depth.
- Likely fix: make every staged script of `src` a candidate root in the `--listFilesOnly` run, or set
  `maxNodeModuleJsDepth` in the stage tsconfig. The implementer plans the details and checks Svelte's
  `emitSvelteTypes()` for the same gap.
- Test: build area, beside the declaration clash cases in `packages/e2e/build/mf-build-findings.spec.ts`: a
  type-only `src/title.jsx` (no clash) types `Card.ucf`, React and Vue build green with `title.d.ts`; and a
  `src/card.jsx` beside `src/Card.ucf` is the `name-clash` the declaration name check reports.

## Docs

`docs/architecture.md`, the library paragraph, if the staging changes. Otherwise none.

## Done when

- A type-only `.js` / `.jsx` module of `src` types a component in the React and Vue (and Svelte, if affected) builds.
- `pnpm devx check` is green.
- the simplify-comments pass ran on every touched source file, committed on its own.

## Plan: list JS modules at any depth (approved 2026-10-15)

Run by a delegated session in automatic mode: the delegation was the approval.

- Cause confirmed. Each stage file sits under `node_modules`, so tsc's listing run dropped a JS module reached only by
  `import type` (React: `TS7016`; Vue: the same with `.js`; Svelte: no error, `title.d.ts` silently missing).
- Fix in `reachedRoots()` (`packages/vite/src/library/dts.ts`), shared by all three builds: the `--listFilesOnly` run
  passes `--maxNodeModuleJsDepth 1073741824` and `--jsx preserve`. The real run then takes every reached file as a root,
  as before. The stage tsconfig is unchanged, so a third-party JS package still types as the library's own tsc does.
- `--jsx preserve` (listing only): without `jsx`, tsc skips a `.jsx` module. Vue's real run still reports that as
  `TS6142` when the library sets no `jsx`; svelte2tsx's `emitDts` reports nothing, so Svelte would drop it unseen.
- Unlimited depth makes the listing run load an untyped package's JS, which the real run never loads. Its errors there
  (Flow syntax, say) no longer fail the build: the listing run throws only when an error names a stage file or no file.
- Tests in `packages/e2e/build/mf-build-findings.spec.ts`: `title.js` (React, Vue, Svelte), `title.jsx` (React,
  Svelte, and Vue with the library's `jsx` set) and `title.tsx` (Svelte, no `jsx`) type `Card.ucf` and ship
  `title.d.ts`; so does a `title.js` reached through `src/types.ts`; an untyped Flow package, shimmed by a `src` `.d.ts`,
  builds; `card.jsx` / `card.js` beside `Card.ucf` is the `name-clash` (React, Vue: Svelte ships `Card.svelte.d.ts`);
  Vue with `title.jsx` and no `jsx` reports `TS6142`. Vue types through `const heading: CardTitle = props`: its
  compiler reads no JSDoc type inside `defineProps<...>()`.
- Departs from Direction and Done when for Vue: a `.jsx` module there needs the library's own `jsx` (its tsconfig is
  extended), else `TS6142`, as plain vue-tsc does. With `jsx` set it ships, tested.
- Docs: `docs/architecture.md`, library paragraph, the listing run.
