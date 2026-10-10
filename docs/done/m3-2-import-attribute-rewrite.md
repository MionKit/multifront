---
type: feature
spec: full-plan
status: done
created: 2026-10-10
milestone: 3
step: 3.2
---

# Milestone 3.2: import attribute rewrite in core

## Problem

Spec 4.4: browsers and Node reject unknown import attributes, so every host must read `with { framework }` off a
`.ucf` import and move it into the specifier before a runtime sees it. Users: the Vite post plugin (3.7), the
`resolveTarget` tests (3.3), later the Vue and Svelte script hosts (M4, M6). Today the only reader is a test helper
(`packages/core/test/imports/readImports.ts:67-91`, its own oxc Visitor), and nothing rewrites. M2's
`fixtures/apps/imports/` also lacks the import forms 3.3 and 3.7 need rows for.

## Plan

### 1. `packages/core/src/imports/rewrite.ts`, exported from `packages/core/src/index.ts`

```ts
rewriteImportAttributes(code: string, filename: string): {
  code: string; map: SourceMap | null; imports: UcfImport[]; errors: Diagnostic[];
}
```

`UcfImport` in `packages/core/src/types.ts`, exported as a type:

```ts
interface UcfImport {
  kind: 'static' | 'reexport' | 'dynamic';
  specifier: string; // as written, before the rewrite
  framework?: string; // the attribute's value, unchecked ('angular' too); unset without one or when not literal
  start: number; // the specifier literal, quotes included, offsets into `code`
  end: number;
}
```

- Code without `.ucf` → returned as is (`map: null`, no imports, no errors), no parse.
- Parse: oxc-parser `parseSync`, `sourceType: 'module'`. `lang` from the path before `?`: `.tsx` / `.jsx` as is,
  `.ts` / `.mts` / `.cts` → ts, `.js` / `.mjs` / `.cjs` → js; else a `lang.<x>` query
  (`C.vue?vue&type=script&setup=true&lang.ts`); else ts. Parse errors → input untouched, no imports, no errors (the
  importer's own compiler reports them). A static `with {framework: x}` is already a parse error in oxc.
- Imports: `ImportDeclaration` → static; `ExportNamedDeclaration` with a source and `ExportAllDeclaration` → reexport;
  `ImportExpression` → dynamic. The specifier is a string literal (or, for `import()`, a template literal without
  expressions) whose value ends in `.ucf`: the TS plugin's `isUcfSpecifier` test. Found with oxc's `Visitor`, so
  strings and comments are never touched.
- Static and reexport: `node.attributes`, key an Identifier or a string. `framework` the only key → remove from the
  specifier's end through the clause's `}` (found by scanning past whitespace, commas and comments). Other keys → only
  that attribute and its comma.
- Dynamic: `node.options` an object literal with a `with` object literal holding `framework`. Same removal; an emptied
  `with` removes its property, an emptied options object removes the whole argument (`import(x, {…},)` →
  `import(x)`).
- Specifier: `?framework=<encodeURIComponent(value)>` before the closing quote or backtick.
- `framework-attribute-not-literal` (joins `DiagnosticCode`, not `TargetErrorCode`), via `createDiagnostic`. The
  import stays unedited and listed without `framework`. Raised for a `framework` value that is not a string or plain
  template literal, and for `import()` options or their `with` value that is not an object literal or holds a spread
  or a computed key.
- Map: MagicString `generateMap({source: filename, hires: true, includeContent: true})` as our `SourceMap`;
  `null` when nothing changed.
- `magic-string` exact-pinned in core `dependencies`: newest past the 30 day age (1.3.1, or the newest pnpm
  accepts).

### 2. Fixtures, `packages/e2e/fixtures/apps/imports/` (M2's one set)

- The default-react project is M2's `src/` (root `tsconfig.json`, `framework: 'react'`): `default.ts`, `App.tsx`
  (importer over default), `lazy.ts` (svelte attribute over default), `reexport.ts` (vue). No new files.
- `no-default/` (`importers: {'.mts': 'vue'}`, no `framework`); `bare.ts` is the "none" case. New: `attribute.ts`,
  `attribute-over-importer.tsx` (`vue` in a `.tsx`), `reexport.ts`, `export-all.ts`, `dynamic.ts`, `importer.tsx`,
  `importer.jsx`, `non-literal.ts` (`{with: {framework}}` shorthand), `unknown.ts` (`angular`),
  `strings-and-comments.ts` (every form inside comments, a string and a template; no row).
- `react-only/` comes with 3.3 (`frameworks`, `target-not-enabled`); each sub-project's `vite.config.ts` with 3.7.
- `expected.ts`: a row per new import; the error branch also takes `framework-attribute-not-literal`.
- `packages/e2e/fixtures/apps/rewrite-edges/` (`.js`, so the formatter leaves them as written; never built):
  `other-keys.js`, `dynamic-options.js`, `comments.js`, `not-literal-options.js`.

### 3. Tests reading the set

- `readImports.ts`: its Visitor gives way to `rewriteImportAttributes(script.code, …)`; it returns `{imports, errors}`.
  `scriptsOf` stays, and a script of a `.ucf` / `.vue` / `.svelte` file goes in as `<file>?lang.<x>`.
- `resolveTarget.spec.ts`: the `framework-attribute-not-literal` row checks the rewrite's errors; new messages.
- `packages/e2e/editor/tsserver.spec.ts`: `ROWS` leaves out `no-default/non-literal.ts` until 3.8.

## Tests

`packages/core/test/imports/rewrite.spec.ts` (core project; this host and CI `check`, no new infra). Every importer
of `fixtures/apps/imports/` (scripts of `.vue` / `.svelte` through `scriptsOf`; `.ucf` left out, block imports never
go through the rewrite) and every `rewrite-edges/` file:

- the output parses with zero errors; no `framework` key in any attribute list or `import()` `with` object;
- each `.ucf` specifier carries `?framework=<value>` exactly when the source had the attribute (oracle: `expected.ts`
  rows);
- a second run changes nothing (`map: null`, the same errors; rewritten specifiers no longer end in `.ucf`, so it
  finds no import to move);
- every statement's first keyword and every Identifier in the output map back through `map` (trace-mapping) to the
  same text in the input;
- a JSON file snapshot of `{code, imports, errors}` per file, under `packages/core/test/__snapshots__/rewrite/`;
- hand-written: `non-literal.ts` gives `framework-attribute-not-literal` at its line and column,
  `not-literal-options.js` its four errors, `strings-and-comments.ts` comes back unchanged.

Existing tests now cover the new rows: `resolveTarget.spec.ts`, `packages/language-tools/test/resolve.spec.ts`,
`packages/e2e/editor/tsserver.spec.ts`.

## Docs

- Milestone doc: 3.2 matched to what shipped + `- Status: done`; 3.3 gains `react-only/`; 3.7 the `vite.config.ts`
  files; 3.8 lifts the `non-literal.ts` exclusion. Spec, architecture, plan: none (they already say it).

## Decisions

- `map: SourceMap | null`, as the step fixes it.
- `react-only/` and `not-enabled.ts` move to 3.3 (they need its `frameworks` and `target-not-enabled`).
- M2's `src/` is the default-react project; no duplicate folder.
- The `vite.config.ts` files come in 3.7 (`importers` exists only from 3.6).
- `no-default/non-literal.ts` stays out of `tsserver.spec.ts` until 3.8.
- A plain template counts as a literal for `import()` (the editor agrees); non-object `import()` options are
  `framework-attribute-not-literal`; edge fixtures are `.js`; no fuzz test.

## Out of scope

- The Vite post plugin (3.7), `resolveTarget` changes (3.3), the TS plugin reporting the new code (3.8).
- Specifiers with a query; `framework` on non-`.ucf` imports.

## Done when

- `rewriteImportAttributes` and `UcfImport` exported from `@multifront/core`, `magic-string` pinned.
- Fixtures and rows in place; `rewrite.spec.ts` and every test over the set green; `pnpm devx check` passes.
- Milestone doc matched; this todo moved to `docs/done/`.
- The simplify-comments pass ran on every touched source file, committed on its own.
