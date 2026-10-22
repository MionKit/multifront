# Public docs

Rules for writing `publicdocs/`, the docs for people who **use** multifront.

- Readers: library authors who write `.front` components, and the apps that use those libraries.
- Plain Markdown + images, read on GitHub. No website.
- Reader wants a job done: write a component, style it, import it, build the library. Not how it works inside.
- multifront = compilers + plugins → most pages: a config snippet, a `.front` snippet, what comes out.

## Layout

```
publicdocs/
  README.md                  the landing page: what multifront is, one card, the list of pages
  <NN>-<slug>.md             one page per job, numbered in reading order: 01-getting-started.md
  assets/src/<name>.html     the cards, one HTML file each
  assets/<name>.png          rendered by `pnpm devx docs-images`; commit it with its HTML
```

- Only these. No subfolders of pages, no other formats.
- `README.md` page list = table of contents: every page in it, in number order.
- Planned pages below, one job each. Add a page only when what it describes has shipped:

| Page | Covers |
| --- | --- |
| Getting Started | install, the Vite config, a first `.front` file rendered in an app |
| Component Files | the `.front` format: blocks, what goes in each, the rules and their errors |
| Styles | scoped CSS, CSS modules and `$style`, preprocessors, global styles |
| Imports | importing a `.front` file, how the framework is picked, mixing frameworks |
| Editor Setup | the VS Code extension, the TypeScript plugin, the command line checks |
| Building a Library | the library build, what gets published, using it from each framework |
| Errors | every error code: what it means and how to fix it |

## What goes in, what stays out

- **Only what has shipped**: on `main`, with a test. No "coming soon", plans, status lines or milestone names.
- **How to use it, not how it works.** No splitter, block kinds, virtual modules, build context or other internals.
- Internal name only where the user sees it: an error message, a file name in the dev tools, an option.
- **Document the contract**: what a `.front` file compiles to, which framework an import gets, what an error means.
- **Vue is the reference.** Same as Vue (scoped styles, CSS modules, `$style`) → one sentence + link Vue's docs.
- Never explain again what Vue's docs explain.

## Writing rules

- **Clear, very concise.** Say it once, fewest plain words. Cut what does not help the reader do or understand.
- **No em dashes.**
- **One section, one job**:
  - **How** to do something: one sentence, then the example.
  - **What** a feature is: describe it, then show it.
  - **Why** it works a particular way: the reason, short.
- **Titles name the job.** Title Case, noun phrase or gerund: "Scoped Styles", "Picking the Framework".
- Title stands alone: no code names, no backticks, no questions, no slogans.
- **One table per topic.** Several small tables with the same columns = one table.
- **Tip where something works a particular way** (a default, an order, a gotcha): 1-2 sentences, `> **Tip:** …`.
- Tip tells how. `> **Note:** …` only informs.
- **Each fact once per page**: paragraph, example, table or tip. Never two of them.

### The ideal section

~~~md
## Title                 <- names the job, stands alone

One or two sentences.    <- what it does and when you use it. No lead-in sentence.

```vue                   <- the example: 5 to 15 lines, only what this section explains
```

| … |                    <- optional: one table for the variants

> **Tip:** …             <- optional: one or two sentences
~~~

### Examples

- **Real code only.** Copied from a file the tests run: a fixture in `packages/e2e/fixtures/` or a tested app.
- Copy the lines that matter. Name the file above the block when the reader needs it (`Card.front`, `vite.config.ts`).
- 5 to 15 lines. No setup the reader does not need, no second feature.
- Comments: one-liners on the line they explain.
- Fence languages: `vue` for `.front` files (GitHub colors each block by its `lang`), `ts`, `tsx`, `svelte`, `css`,
  `scss`, `bash`, `json`.

## Cards

- Card = image that explains an idea faster than text. Never decoration.
- e.g. one file becoming three frameworks, how an import picks its framework, what a library build publishes.
- **At most one per section**; most sections need none. Never replaces the example.
- **One idea per card**: a title, a short subtitle, the picture.
- Text the reader acts on (a command, an option) goes in the page, not only in the card.
- Alt text says what the card shows:
  `![One Card.front file compiles to a Vue, a React and a Svelte component](assets/one-file-three-frameworks.png)`
- Card files: [public-docs-cards.md](../.agents/docs/public-docs-cards.md). Read before writing or rendering a card.

## Checks before the PR

- Every relative link and image path resolves.
- Every example still matches the file it came from.
- `grep -n '—' publicdocs/` prints nothing.
- Every card's PNG is rendered from its current HTML and committed with it.
