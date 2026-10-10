---
type: fix
spec: guidelines
status: ready
created: 2026-10-10
---

# Core's import rewrite breaks in the wasm-bundled editor tools

## Intent

`rewriteImportAttributes` (`packages/core/src/imports/rewrite.ts`) walks the program with oxc-parser's `Visitor`.
The VS Code bundles (`scripts/lib/bundle-vscode.mjs`) alias `oxc-parser` to its wasm entry (`src-js/wasm.js`), which
exports `parseSync` and `visitorKeys` but no `Visitor`. Any bundled code path that calls the rewrite throws
`wasm_exports.Visitor is not a constructor`. Today no bundle calls it, so nothing fails yet; the TypeScript plugin
reporting `framework-attribute-not-literal` through the rewrite (milestone 3, step 3.8) will.

Found while building `react.check`, which hit the same error in `packages/e2e/editor/bundle.spec.ts` and switched to
core's own `walk` (`packages/core/src/ast.ts`, built on `visitorKeys`).

## Direction

- Switch `rewrite.ts` from `Visitor` to `walk` from `packages/core/src/ast.ts`. Same node types, same order of edits.
- Prove it on the bundle: a test that runs the rewrite from the bundled code (the unzipped `.vsix` of
  `packages/e2e/editor/bundle.spec.ts`), or the 3.8 TypeScript plugin case once it lands. The implementer picks.
- No `Visitor` import left in core.

## Docs

None: no behaviour or structure changes.

## Done when

- `rewrite.ts` uses no `Visitor`, the rewrite tests stay green, and a bundled run of the rewrite passes.
- The simplify-comments pass ran on every touched source file, committed on its own.
