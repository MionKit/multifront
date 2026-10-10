---
type: feature
spec: full-plan
status: ready
created: 2026-10-10
milestone: 3
step: 3.4
---

# Milestone 3.4: react.check(), the block rules

## Problem

`react.check()` (`packages/core/src/blocks/react.ts`) only has M1's `react-no-default-export`. When a `<react>` block
does not parse it reports nothing (react.ts:28). The Vite `load` hook (3.6) needs every `<react>` rule in the `.ucf`
file at the exact spot: a syntax error (`react-syntax-error`), and a `with { framework }` inside the block
(`framework-in-block`, spec 4.1). No fixture pins the default export forms the check accepts.

## Plan

### 1. Types, `packages/core/src/types.ts`

- `DiagnosticCode` (types.ts:62-77) gains `'react-syntax-error'`. `framework-in-block` is already there (`TargetErrorCode`).

### 2. `packages/core/src/blocks/react.ts`

- `check(block, split)` keeps its signature (`BlockKind.check`) and the oxc-parser call (`parseSync(split.filename,
  block.content, {lang: 'tsx', sourceType: 'module'})`).
- **`react-syntax-error`**: the parse has errors → one diagnostic per oxc error, and no other rule runs (a partial
  program says nothing about exports or imports). Range = the error's first label, offset by `block.contentStart`
  (oxc labels are UTF-16: a label after an emoji slices the exact token). An error with no label points at the
  opening `<react>` tag. Message `<react> does not parse: <oxc message>`, like
  `<style lang="scss"> does not compile: <reason>`. Line and column through `createDiagnostic`.
- **`react-no-default-export`**: M1's check, unchanged. `export {default} from '...'` is already accepted (react.ts:41);
  this step pins it with a fixture.
- **`framework-in-block`**: an oxc `Visitor` over the program. A `.ucf` import counts with the same rule as
  `rewriteImportAttributes`: specifier is a string literal or a template literal without expressions, ending in `.ucf`.
  - `ImportDeclaration`, `ExportNamedDeclaration` (with a source), `ExportAllDeclaration`: each attribute whose key
    is `framework` (identifier or string key).
  - `ImportExpression`: options is an object literal, its non-computed `with` property is an object literal, each
    non-computed property keyed `framework`, whatever its value (literal or not: inside a block the attribute itself
    is the error). Options that cannot be read statically (a variable, a spread) give nothing.
  - Range = the attribute node (`framework: 'vue'`). Message = resolveTarget's own:
    `a framework attribute cannot sit inside the <react> block; imports there always get react`, one code one message.
- Helpers reused, not copied: `rewrite.ts` exports `literalValue` and `keyName` (module exports only, not from
  `index.ts`); `resolveTarget.ts` exports `frameworkInBlockMessage(block: Target)` and uses it at resolveTarget.ts:43.

### 3. The language server leaves two codes to tsserver, `packages/language-tools/src/multifrontService.ts`

- Hybrid mode: tsserver with our plugin already reports TypeScript's syntax errors inside `<react>` and
  `framework-in-block` on the import. One problem, one error (M2 2.9).
- One named set beside the service, `TSSERVER_CODES = ['react-syntax-error', 'framework-in-block']`, exported from
  `@multifront/language-tools` so the editor tests read the same list. `provideDiagnostics` drops those codes.

### 4. Fixtures, `packages/e2e/fixtures/components/react/`

Paths from `react/errors/` to the shared components are `../../X.ucf`.

- `errors/NoDefault.ucf`: a `<style scoped>` first, then `<react>` with a plain `function NoDefault()` and no export:
  `react-no-default-export` at the `<react>` tag (line 7, column 0).
- `errors/NamedOnly.ucf`: `<react>` with `export function NamedOnly`, `export const label`,
  `export { NamedOnly as Other }`: `react-no-default-export` at line 1, column 0.
- `errors/AttrInBlock.ucf`: `<react>` with a bare `import Card from '../../Card.ucf'` (no error) and six attributes,
  one `framework-in-block` each, at the attribute:
  - `import Badge from '../../Badge.ucf' with { framework: 'vue' }`
  - `import Button from '../../Button.ucf' with { type: 'component', "framework": 'react' }` (string key, the block's
    own framework, another key beside it)
  - `export { default as Panel } from '../../Panel.ucf' with { framework: 'svelte' }`
  - `export * from '../../Hello.ucf' with { framework: 'vue' }`
  - `import('../../Card.ucf', { with: { framework: 'vue' } })`
  - ``import(`../../Badge.ucf`, { with: { 'framework': pick() } })`` (template specifier, non-literal value)
  - plus `export default function AttrInBlock()` rendering Card, Badge and Button.
- `errors/SyntaxError.ucf`: `export default function Broken()` returning `<p title="café 😀">Broken</div>`:
  one `react-syntax-error` on `div` (the label oxc gives), message
  `<react> does not parse: Expected corresponding JSX closing tag for 'p'.`; the emoji before it pins UTF-16 columns.
- `default-forms/`, one file per accepted form, each a `<react>` block only:
  `DefaultFunction.ucf` (`export default function`), `DefaultClass.ucf` (`export default class ... extends Component`),
  `DefaultArrow.ucf` (`export default () => ...`), `DefaultMemo.ucf` (`export default memo(function ...)`),
  `DefaultIdentifier.ucf` (`export default DefaultIdentifier`), `AsDefault.ucf` (`export { AsDefault as default }`),
  `DefaultFrom.ucf` (`export { default } from '../../Card.ucf'`). All names unique across `fixtures/components/`.

## Tests

All run in `pnpm devx test` (core and e2e vitest projects; CI `check` job and this host). No new infra.

- New `packages/core/test/blocks/react.spec.ts` (3.5 extends it with `build`):
  - Hand-written table per `react/errors/` fixture: `{code, line, column, text}` per diagnostic, `text` =
    `source.slice(start, end)` (`<react>`, the attribute text, `div`). Each fixture through `splitBlocks` and
    `getBlockKind('react').check(split.targets.react!, split)`: exactly those rows in source order; `split.errors` empty;
    line and column agree with `start`; `checkBlocks(split)` gives the same list (the host call).
  - JSON file snapshot per error fixture: `__snapshots__/react/errors/<name>.ucf.json` (pins the messages).
  - `listComponents('react/errors')` and `listComponents('react/default-forms')` equal the tables, so no fixture
    goes unchecked.
  - Every `default-forms` file: `react.check` gives `[]`, `split.errors` empty, and its block holds the form its row
    names (`export default class`, `export { default } from`, ...).
- `packages/core/test/check.spec.ts`: `invalid/ReactSyntaxError.ucf` and `invalid/ReactCloseInString.ucf` now get
  `react-syntax-error`, so they leave `SPLIT_FIXTURES` (check.spec.ts:48). Their test (check.spec.ts:80-87) becomes:
  TypeScript's parser also rejects the block (`tsxSyntaxErrors`), `checkBlocks` = the splitter errors plus at least
  one `react-syntax-error` and nothing else, every added one inside the block content, no `react-no-default-export`.
- `packages/e2e/editor/lib/cases.ts`: the language server's diagnostics on every `invalid/` fixture equal
  `checkBlocks` minus `TSSERVER_CODES` (also run by `bundle.spec.ts` against the vsix server).
- New editor test `packages/e2e/editor/tsserverCodes.spec.ts`: the real language server and a real tsserver with our
  plugin, both on `react/errors/AttrInBlock.ucf` and `react/errors/SyntaxError.ucf`. Each `framework-in-block`
  import is reported once, by tsserver, and the language server sends no `framework-in-block`; the syntax error is
  reported by tsserver on its line, and the language server sends no `react-syntax-error`.
- No change needed, they pick it up: `packages/e2e/build/build-context.spec.ts` (every diagnostic at its real line
  and column), and `packages/core/test/split.fuzz.spec.ts` ("an undamaged file: checkBlocks adds nothing" now covers
  both new codes).

## Docs

- `docs/milestones/m3-react-and-imports.md`: `- Status: done` on 3.4; the `framework-in-block` bullet says "on a
  `.ucf` import"; the Deliverable notes the language server leaves `react-syntax-error` and `framework-in-block` to
  tsserver; the hand-off line `react.check(block)` becomes `react.check(block, split)` (the M1 signature that
  shipped), with the same note on milestone 7.
- `docs/spec.md` 3.2 (spec.md:80): the `checkBlocks` rule list gains "a `<react>` block that does not parse, a
  `framework` attribute on an import inside `<react>`".
- `publicdocs/07-errors.md`: a `react-syntax-error` row under "Component File Errors" (fix the syntax error the
  message names). The `framework-in-block` row already fits.
- plan / architecture: none, no structure change.

## Fuzzing

None added. The split fuzz already checks that `checkBlocks` adds nothing on undamaged mutations, which now
includes both new codes. A differential oracle (oxc vs TypeScript syntax errors on damaged blocks) would flake on
the parsers' known edge differences.

## Decisions

- Orchestrator: the language server leaves `react-syntax-error` and `framework-in-block` to tsserver (hybrid mode,
  "one problem, one error"); one named list, its own editor test.

## Out of scope

- A `framework` attribute on a non-`.ucf` import (milestone Out of scope).
- `react.build` (3.5), Vite reporting through `this.error` (3.6), the TypeScript plugin (3.8).

## Done when

- Every test above passes and `pnpm devx check` is green.
- The milestone step says `- Status: done`, and this todo sits in `docs/done/`, matching what shipped.
- The simplify-comments pass ran on every touched source file, committed on its own.
