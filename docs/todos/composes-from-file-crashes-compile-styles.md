---
type: fix
spec: guidelines
status: ready
created: 2026-10-10
---

# `composes: … from` a missing or broken file crashes the process in compileStyles

## Intent

In a `<style module>` block, `composes: b from './other.css'` makes `compileStyles()` (core, `src/styles.ts`) crash the
whole Node process when `other.css` is missing or does not parse. The error is not returned, and it is not a
rejected promise: it is an uncaught exception, so a Vite dev server or an editor server running our pipeline dies.
Every other compile error becomes a `style-compile-error`. This one must too.

Seen with `@vue/compiler-sfc` 3.5.42 and its bundled postcss-modules (`dist/compiler-sfc.cjs.js`, the
FileSystemLoader around :13258 and :13344):

- missing file: the `ENOENT` comes back in `result.errors`, then the loader's `readFile` callback still calls
  `Core.load` with `undefined`, and that throws "PostCSS received undefined instead of CSS string" with no handler;
- broken file: `Core.load` throws a `CssSyntaxError` inside the same callback, again with no handler.

plugin-vue never hits this: it leaves module blocks to Vite's CSS modules. Our pipeline does, because 1.8 compiles
modules through `compileStyleAsync({modules: true})`.

## Direction

- Confirm on the current `@vue/compiler-sfc` first; an upstream fix may already exist (postcss-modules, or how
  compiler-sfc bundles it). If it does, raise the supported range and add the test.
- Otherwise options to weigh: a `modulesOptions.Loader` that reads files with promises and turns a failure into a
  rejected fetch, or reading `composes … from` paths before compiling and reporting a missing or broken file as a
  `style-compile-error` at that `composes` declaration. The implementer plans the details.
- A fixture pair under `packages/e2e/fixtures/components/invalid/` (a `.ucf` with `composes … from` and the missing or
  broken file), run in a child process or a worker so a crash fails the test instead of killing the run.

## Docs

`docs/milestones/m1-splitter-block-kinds-styles.md` (1.8, `compileStyles`) if the error shape changes; spec 3.3 only
if `composes … from` support changes.

## Done when

- Both cases give one `style-compile-error` from `compileStyles()`, and the process keeps running.
- The simplify-comments pass ran on every touched source file, committed on its own.
