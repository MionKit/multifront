# Architecture

How multifront turns one `.ucf` file into a Vue, React or Svelte component, for the bundler and for the editor. What we build: [spec.md](spec.md). In which order: [plan.md](plan.md).

![A file of files](assets/overview.png)

## The idea

Every root block becomes a normal file that an existing tool already understands, with a map back to the original lines.

- We write no compilers and no language services.
- We make those virtual files and pick the tool for each one.
- The file ending picks the tool: `lang.tsx` goes to plugin-react, `lang.css` to Vite's CSS step.

## Where we sit next to Vue

A Vue single file component is already a file of files:

1. `compiler-sfc` `parse()` splits `Card.vue` into script, template and style blocks.
2. plugin-vue turns each block into a sub-module, like `Card.vue?vue&type=style&index=0&lang.scss`. The `lang.scss` ending lets Vite's normal plugins compile it.
3. In the editor, `@vue/language-core` splits the same way and hands each block to the TypeScript, HTML or CSS service as "embedded code".

We add the same layer **one level higher**: a `.ucf` file is a file of components. For the `<vue>` block, what we make is plain Vue SFC code, so Vue's whole pipeline runs unchanged underneath ours.

## Block kinds

Every root tag, `<style>` included, is a **block kind** with the same five operations:

```ts
// Core half: packages/core/src/blocks/index.ts, BLOCK_KINDS
interface BlockKind {
  tag: 'react' | 'vue' | 'svelte' | 'style';
  role: 'target' | 'shared';         // target = a framework component, shared = used by every target
  grammar: {scopeName, languageId, byLang?}; // VS Code highlighting; byLang picked by <style lang>
  check(block, split): Diagnostic[]; // rules for the block, e.g. "react must export default"
  fillContext?(blocks, ctx): Promise<void>; // shared kinds only: fill ctx before any build
  build?(block, ctx): VirtualFile;   // the file the bundler compiles
}

// Language-tools half: packages/language-tools/src/blocks/index.ts, same tags, same order
interface EditorBlockKind {
  tag: 'react' | 'vue' | 'svelte' | 'style';
  types?(block, ctx): EditorFile;    // the file TypeScript reads: what the module exports
  editor?(block, ctx): EditorFile[]; // embedded codes for tsserver (TypeScript) and our language server (the rest)
}

interface VirtualFile {
  ext: '.tsx' | '.vue' | '.svelte' | '.css' | '.scss' | '.ts';
  code: string;
  map: SourceMap | undefined; // back to the block in the .ucf file
}

interface EditorFile extends VirtualFile {
  mappings: CodeMapping[]; // Volar mappings with per-span feature flags; map stays undefined
}
```

- **Shared blocks run first** and fill `ctx`: the scope id, the `$style` class map and the CSS module ids. `createBuildContext()` in core calls each shared kind's `fillContext`, in registry order. The chosen target reads `ctx`.
- **Lint and format need no operation of their own.** oxlint and oxfmt run on each block's own text, named with the ending of its `build` file (`.tsx`, `.vue`, `.svelte`) or its style `lang`. They never see generated code, so nothing generated is ever written back into a `.ucf` file.
- **One rule for the Vue row:** it takes the raw `<style>` blocks into its SFC code, so plugin-vue compiles them itself. React and Svelte use the compiled CSS from `ctx`.

## The grid

A block kind is a row, an operation is a column, and each cell names the existing tool that does the work.

![Every root block, the same five operations](assets/grid.png)

### Adding a block kind

1. A new framework (Solid, say) is a `target` row: its grammar, its rules, its Vite plugin, its type output, its language service.
2. A new shared block (a `<types>` block, say) is a `shared` row that adds values to `ctx`.
3. Add the row to the registry in both packages (see below). A test fails if a tag has only one half.

Nothing else changes: the hosts loop over the registry.

## Hosts

A host is a program that runs the operations. Each one does the same three steps: split the file once (cached), pick the target, ask the block kinds for the files it needs.

| Host | Package | Operations it calls |
| --- | --- | --- |
| Vite plugin | `@multifront/vite` | `check`, `build` |
| Language server | `@multifront/language-tools` | `check`, `editor` (CSS, template HTML) |
| TypeScript plugin (in VS Code's tsserver), `mf-tsc` | `@multifront/language-tools` | `types`, `editor` (TypeScript codes) |
| `mf-lint`, `mf-fmt` | `@multifront/language-tools` | the block text, named by `build`'s ending |
| VS Code extension | `packages/vscode` | `grammar`, at packaging time |

## Build

What the Vite plugin does when an app imports a `.ucf` file. Only the chosen target is compiled; the other blocks never reach the bundle.

![One import, one target, one module](assets/build.png)

- The target rules are spec section 4. They live in one function, `resolveTarget()` in core.
- The Vue target keeps the real file path as its module id, because plugin-vue re-reads the file from disk on a cache miss. Details in [plan.md](plan.md), "Building on plugin-vue".
- Browsers and Node reject unknown import attributes, so a post plugin moves `with { framework }` into the module id before any runtime sees it.

## Editor and types

![The same blocks, seen by the editor](assets/language.png)

- **Highlighting:** VS Code TextMate grammars can embed another language between a begin and an end tag; Vue's extension does this for `<style lang="scss">`. Our grammar is generated from the registry, one rule per tag. The extension bundles pinned copies of the Vue and Svelte grammars (both MIT), so it works without their extensions installed. The copies are served under our own scopes (`source.ucf.vue`, `source.ucf.svelte`, `source.ucf.vue.vue.*`), so they never clash with those extensions. VS Code reads injections only from the document's root grammar, so their injections move to `source.ucf`, each one limited to its own block.
- **Hybrid mode:** VS Code's own tsserver, with our TypeScript plugin, does every TypeScript job, inside `.ucf` files too. So there is one TypeScript program: unsaved edits reach importers at once, and rename and references cross file kinds. Our language server does the rest.
- **Inside a `.ucf` file:** each block's `editor()` codes go to tsserver (TypeScript) and to our language server (CSS, template HTML), which asks tsserver when it needs types.
- **Importing a `.ucf` file:** TypeScript never reads import attributes, so our TypeScript plugin resolves `./Card.ucf` with `resolveTarget()`, the same function the build uses, and points it at that target's `types()` script. tsserver serves one script per `.ucf` file (Volar's tsserver plugin has no extra scripts), so in M2 the React script is the `.ucf` file's own; the Vue target must serve its script another way.

## Where the code lives

`@vue/language-core` and `svelte2tsx` are heavy and must stay out of a build. So each block kind is two files with the same name, one per package:

```
packages/core/src/blocks/
  index.ts          the registry: every BlockKind, in order (shared first)
  style.ts          check · build · grammar
  react.ts
  vue.ts
  svelte.ts
packages/language-tools/src/blocks/
  index.ts          the same tags, editor halves
  style.ts          editor
  react.ts
  vue.ts
  svelte.ts
```

## Updating the graphics

The images are HTML pages under [assets/src/](assets/src/), styled with the mion website palette in [assets/src/theme.css](assets/src/theme.css): olive for Vue, blue for React, orange for Svelte, purple for styles. Edit a page, then render it to PNG:

```bash
pnpm devx docs-images            # every page
pnpm devx docs-images grid       # one page
```

Commit the HTML and the PNG together.
