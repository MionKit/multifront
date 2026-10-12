---
type: chore
spec: guidelines
status: blocked
created: 2026-10-12
---

# Test the library types step's missing optional-peer error from a packed install

## Intent

`buildLibrary()` writes `.d.ts` files with tools that are optional peers of `@multifront/vite`: `typescript` (React),
`vue-tsc` (Vue) and `@multifront/language-tools` (React). When one is not installed, the types step throws
`buildLibrary: the <target> types need <package>; install it, or set dts: false`
(`packages/vite/src/library/types.ts`, `missingPeer()`). No test covers that message. In this repo all three are always
installed, and faking their absence would be a mock, which the testing rules forbid. A user who installs only `vite`
and `@multifront/vite` hits this path first, so it should be pinned.

## Direction

- Blocked until packed workspace packages can be installed together. A packed `@multifront/vite` depends on
  `@multifront/core` (and lists `@multifront/language-tools` as a peer), so its tarball installs only next to packed
  copies of those, through the local registry `docs/milestones/README.md` plans for the consumer area ("later a local
  registry for packed packages that depend on each other").
- Then a consumer-area test: a fresh temp project with the packed `@multifront/vite`, `vite`, the framework plugin and
  the framework, but no `typescript` / `vue-tsc` / `@multifront/language-tools`. Run `buildLibrary()` (or `mf-build`) on a
  copy of the library fixture and check that the message names the missing package. Then check that `dts: false` builds.
- The implementer plans the details once the registry exists.

## Docs

None: the message is already described where the types step is (milestone 6, step 6.6). A `publicdocs/` page that lists
the optional peers may need a line, if one exists by then.

## Done when

- A consumer-area test runs `buildLibrary()` from a packed install with each optional peer missing in turn, and checks
  the message names it. The test runs in CI.
- The simplify-comments pass ran on every touched source file, committed on its own.
