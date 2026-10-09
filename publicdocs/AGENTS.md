# Public docs

How to write `publicdocs/`, the docs for people who **use** multifront: library authors who write `.ucf` components, and the apps that use those libraries. Plain Markdown with images, read on GitHub. There is no website.

The reader wants to get a job done: write a component, style it, import it, build the library. They do not care how multifront works inside. multifront is compilers and plugins, so most pages are a config snippet, a `.ucf` snippet and what comes out.

## Layout

```
publicdocs/
  README.md                  the landing page: what multifront is, one card, the list of pages
  <NN>-<slug>.md             one page per job, numbered in reading order: 01-getting-started.md
  assets/src/<name>.html     the cards, one HTML file each
  assets/<name>.png          rendered by `pnpm devx docs-images`; commit it with its HTML
```

Only these. No subfolders of pages, no other formats. The page list in `README.md` is the table of contents: every page is in it, in its number order.

The pages it will grow into, one job each. Add a page only when what it describes has shipped:

| Page | Covers |
| --- | --- |
| Getting Started | install, the Vite config, a first `.ucf` file rendered in an app |
| Component Files | the `.ucf` format: blocks, what goes in each, the rules and their errors |
| Styles | scoped CSS, CSS modules and `$style`, preprocessors, global styles |
| Imports | importing a `.ucf` file, how the framework is picked, mixing frameworks |
| Editor Setup | the VS Code extension, the TypeScript plugin, the command line checks |
| Building a Library | the library build, what gets published, using it from each framework |
| Errors | every error code: what it means and how to fix it |

## What goes in, what stays out

- **Only what has shipped**, on `main`, with a test. No "coming soon", no plans, no status lines, no milestone names.
- **How to use it, not how it works.** No splitter, block kinds, virtual modules, build context or other internals. An internal name appears only when the user sees it: in an error message, a file name in the dev tools, an option.
- **Behaviour the user can rely on**: what a `.ucf` file compiles to, which framework an import gets, what an error means. That is the contract; the rest is internals.
- **Vue is the reference.** Where multifront behaves like Vue (scoped styles, CSS modules, `$style`), say so in one sentence and link Vue's own docs instead of explaining it again.

## Writing rules

- **Clear and very concise.** Say it once, in the fewest plain words. Cut anything that does not help the reader do or understand something.
- **No em dashes.**
- **One section, one job**:
  - **How** to do something: one sentence, then the example.
  - **What** a feature is: describe it, then show it.
  - **Why** something works a particular way: the reason, short.
- **Titles name the job.** Title Case, a noun phrase or a gerund: "Scoped Styles", "Picking the Framework". A title stands alone, has no code names, no backticks, no questions, no slogans.
- **One table per topic.** Several small tables with the same columns are one table.
- **A tip where something works a particular way**: a default, an order, a gotcha. One or two sentences, as a quote: `> **Tip:** …`. A tip tells how; `> **Note:** …` only informs.
- **Each fact once on the page**: in the paragraph, the example, the table or the tip, never two of them.

### The ideal section

~~~md
## Title                 <- names the job, stands alone

One or two sentences.    <- what it does and when you use it. No lead-in sentence.

```html                  <- the example: 5 to 15 lines, only what this section explains
```

| … |                    <- optional: one table for the variants

> **Tip:** …             <- optional: one or two sentences
~~~

### Examples

- **Real code only.** Every example comes from a file the tests run: a fixture in `packages/e2e/fixtures/` or a tested app. Copy the lines that matter, and name the file above the block when the reader needs it (`Card.ucf`, `vite.config.ts`).
- Five to fifteen lines. No setup the reader does not need, no second feature.
- Comments are one-liners on the line they explain.
- Fence languages: `html` for `.ucf` files, `ts`, `tsx`, `vue`, `svelte`, `css`, `scss`, `bash`, `json`.

## Cards

A card is an image that explains an idea faster than text: one file becoming three frameworks, how an import picks its framework, what a library build publishes. Never decoration.

- **At most one per section**, and most sections need none. A card never replaces the example.
- **One idea per card.** A title, a short subtitle, the picture. Text a reader needs to act on (a command, an option) goes in the page, not only in the card.
- **Use it in Markdown** with alt text that says what the card shows:

  ```md
  ![One Card.ucf file compiles to a Vue, a React and a Svelte component](assets/one-file-three-frameworks.png)
  ```

### Card files

Cards are HTML so a future website can embed them as they are. So each card is a self-contained snippet:

- One file per card, `assets/src/<name>.html`, kebab-case.
- The look comes from the shared palette `docs/assets/src/theme.css` (colours as CSS variables, `.canvas`, `.eyebrow`, `h1`, `.sub`, `.chip`). Use its variables; never hard-code a new colour.
- The whole card is one root element: `<div class="canvas card-<name>">`. Every rule in the card's `<style>` starts with `.card-<name>`, so the snippet cannot leak styles into a page.
- No scripts, no external images, no web fonts. Shapes and arrows are HTML or inline SVG. Text stays real text.
- Width 1200px, set on the root. The height follows the content.

```html
<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../docs/assets/src/theme.css">
<style>
  .card-<name> { width: 1200px; }
  .card-<name> .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 28px; }
</style></head>
<body>
<div class="canvas card-<name>">
  <div class="eyebrow">multifront · styles</div>
  <h1>One title that says the idea</h1>
  <p class="sub">One sentence under it.</p>
  <div class="row">…</div>
</div>
</body></html>
```

Render with `pnpm devx docs-images <name>`, then read the PNG before committing: nothing cut off, nothing overlapping, text readable at half size.

## Checks before the PR

- Every relative link and image path resolves.
- Every example still matches the file it came from.
- `grep -n '—' publicdocs/` prints nothing.
- Every card's PNG is rendered from its current HTML and committed with it.
