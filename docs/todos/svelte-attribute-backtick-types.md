---
type: fix
spec: guidelines
status: ready
created: 2026-10-16
---

# Svelte types break on a backtick in an attribute value

## Intent

svelte2tsx 0.7.61 writes an attribute value with text and tags into a template literal without escaping it:
`<p class="a\b `c` {tone}">` becomes ``"class":`a\b `c` ${tone}` ``, which does not parse. So the `<svelte>` script of
`packages/e2e/fixtures/components/svelte/root-props/Merges.ucf` (line 16, the build's escaping case) gives TS1005,
TS1128 and TS2349 in `mf-tsc`, and broken types in the editor, though Svelte builds the block. The gate
(`packages/e2e/editor/gate.spec.ts`, its `tsconfig.fixtures.json`) leaves `Merges.ucf` out for it. Found while building
the gate. Reproduce with svelte2tsx alone:

```js
svelte2tsx('<script lang="ts">let {tone}: {tone: string} = $props()</script><p class="a\\b `c` {tone}">x</p>',
  {filename: 'X.svelte', isTsFile: true, mode: 'ts', parse, version});
```

## Direction

- A workaround on our side, the way `svelteTypes` (`packages/language-tools/src/blocks/svelte.ts`) already patches
  svelte2tsx's undeclared `$$ComponentProps`: escape `` ` ``, `\` and `${` in attribute text before svelte2tsx reads
  the block (core's `svelteEditorSource`, offsets kept 1:1 or mapped), or fix the generated literal after. The
  implementer picks and plans; mappings into the `.ucf` text must stay exact.
- Report it upstream (sveltejs/language-tools) if no issue exists; drop the workaround once a pinned svelte2tsx fixes it.
- Then `Merges.ucf` leaves the gate's excludes.

## Docs

none beyond the gate's exclude comment, which goes.

## Done when

- `mf-tsc` on `Merges.ucf` gives no error, pinned by a test, and the gate checks it.
- The simplify-comments pass ran on every touched source file, committed on its own.
