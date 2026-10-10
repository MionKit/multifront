---
type: fix
spec: guidelines
status: done
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

## Plan: own CSS modules loader (approved 2026-10-10, delegated session, automatic mode)

- Upstream checked: `@vue/compiler-sfc` 3.5.43 (latest) bundles the same FileSystemLoader, bug unchanged. Vite's own
  postcss-modules copy has it too.
- `compileStyles` passes `modulesOptions.Loader`, a small loader class in `src/styles.ts`. Its `fetch` reads the
  composed file with `fs/promises` and compiles it with `compileStyleAsync` using the block's own `id`, `scoped`,
  `isProd` and module options (so composed class names stay `<local>_<scope id>_<index>`). A read failure or a
  compile error rejects the fetch; postcss-modules then hands it back in `result.errors` as a normal error.
- One state per block, shared by every nesting level: each composed file is compiled once, and only the block's own
  loader emits the composed CSS, dependencies first, each file once. postcss-modules aims for the same order, but
  when two fetches reach one file it can skip recording the dependency, so its order then depends on timing.
- A `composes` cycle between files is reported as an error naming the edge that closes it (postcss-modules hung).
- A bare name (`from 'pkg/file.css'`) is looked up as a package from the importing file, then as a path relative to
  it. Neither found: the package error is reported, naming what the user wrote. postcss-modules looked the package up
  from inside compiler-sfc, missing workspace packages.
- Error shape unchanged: one `style-compile-error` at the `<style>` opening tag, since an error from a composed file has
  no offsets into the block. No milestone doc change.
- Tests:
  - Valid `ComposesFrom.ucf` + `tag-base.css` + `tag-round.css`: relative, nested, bare-package (through
    `@multifront/e2e`, which now exports its fixtures) and bare-relative composes. Its class map is pinned by hand,
    its CSS by snapshot.
  - The style-parity e2e test now builds module blocks too, through plugin-vue + Vite's real CSS modules with our
    class names, and copies the fixture `.css` files into the app: our composed CSS equals theirs.
  - Invalid `ComposesMissingFile.ucf`, `ComposesMissingPackage.ucf`, `ComposesBrokenFile.ucf` + `broken-base.css`,
    `ComposesCycle.ucf` + `cycle-a.css` + `cycle-b.css`.
  - Every `compileStyles` error case runs in a child process (`test/styles.child.ts`, 30 s limit): without the fix
    the broken-file case failed the test file with the `CssSyntaxError` instead of hanging the run.
- Found on the way, filed as its own todo: a `<style module scoped>` block with `composes` never compiles (Vue's
  scoped plugin runs before postcss-modules); plugin-vue + Vite compile it.
