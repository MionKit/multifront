---
type: fix
spec: guidelines
status: done
created: 2026-10-15
---

# mf-build prints Node's own trace above a config that throws a non-Error, on Node 26.12

## Intent

`multifront.config.mjs` holding `throw 'bad config';` must give one stderr line, `mf-build: cannot load <file>: bad
config`, exit 2. On Node 26.12.0, three lines of Node's come first, though `loadConfig()` in
`packages/vite/src/library/cli.ts` catches the error:

```
node:internal/modules/esm/module_job:702
    return this.module.evaluateSync();
                       ^
```

`build/library-cli.spec.ts > mf-build when it cannot run > exits 2 on a config that throws a string` fails in CI
(Linux and Windows), which `node-version: 26` now resolves to 26.12.0. It passes on 26.11.1. The 3 lines also reach
every user on 26.12.

## Direction

- Cause, confirmed outside multifront: on 26.12.0, a module with no top-level await that throws a non-Error, loaded by
  `import()` (Vite's `native` config loader), makes Node write the arrow to stderr natively, even when caught. A thrown
  `Error`, or a module with top-level await, prints nothing. Likely from Node's synchronous ES module loading
  (nodejs/node#62530).
- JS cannot silence it (`process.stderr.write` is not the path). Options to weigh: report it upstream and pin CI to a
  fixed Node until a release fixes it; or load the config where its stderr is ours (a child process), if worth it.
- Never loosen the test's exact-stderr check.

## Done when

- The test passes on the Node CI runs, and mf-build's stderr on that config is the one line on every supported Node.
- `pnpm devx check` is green.

## Plan: load the config under a top-level await (approved 2026-10-15)

The user's call, through the parent session: a real code fix first, no CI pin unless none is possible.

- Root cause, from Node 26.12.0's `module_job.js`: a module graph with no top-level `await` now runs through
  `ModuleJobSync`'s `evaluateSync()`, whose native code prints the arrow when the thrown value is not an object. A graph
  with top-level `await` still runs the async way, which prints nothing.
- Fix in `loadConfig()` (`packages/vite/src/library/cli.ts`): no more `loadConfigFromFile(..., 'native')`. The config
  is imported through a `data:` wrapper, `import * as config from '<file url>'; await 0; export {config};`, so its
  graph is async. Node still resolves the config's imports itself (`--conditions=source` honoured), as `native` did.
  Vite's two remaining steps stay the same: a function export is called with `{command: 'build', mode: 'production'}`,
  and a non-object is `config must export or return an object.`.
- Tests: `build/library-cli.spec.ts > exits 2 on a config that throws a string` now passes on 26.11.1 and 26.12.0
  (failed on 26.12.0 before), both run locally. New guards for the steps now ours: a config function that returns no
  object, a config with no default export, a config that throws an `Error`, and an async config function called with
  the build env (`@acme/build-production`).
- Docs: `docs/architecture.md` (the `mf-build` sentence) and `docs/plan.md` (milestone 6 command line).
