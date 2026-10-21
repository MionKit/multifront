# Editor Setup

The VS Code extension makes VS Code understand `.ucf` files, and gives `.ts`, `.tsx`, `.vue` and `.svelte` files the types of the components they import. The commands `mf-tsc`, `mf-lint` and `mf-fmt` run the same checks on the command line, for CI and coding agents.

## Installing the VS Code Extension

Build the extension from the multifront repository, then install the `.vsix` file it writes. The build needs the tools listed in [SETUP.md](../SETUP.md).

```bash
git clone https://github.com/MionKit/multifront.git
cd multifront
pnpm install
pnpm devx vsix
code --install-extension packages/vscode/multifront-vscode-0.0.0.vsix
```

It brings everything it needs. Only `.vue` files that import a `.ucf` file also need the [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) extension, and `.svelte` files the [Svelte for VS Code](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) extension, each installed before or after this one.

## Editor Features per Block

Open a `.ucf` file and each block gets its own language's features.

| Block | In the editor |
| --- | --- |
| `<react>` | Highlighting, completions, errors, hover, go to definition, rename and find references, also across `.ts` and `.tsx` files |
| `<style>`, `<style lang="scss">` | Highlighting, completions, errors, hover, go to definition |
| `<vue>` | Highlighting, completions (template tags, attributes and directives too), errors, hover, go to definition, rename and find references, also across `.ts` files |
| `<svelte>` | Highlighting, completions in scripts and `{…}` expressions, markup completions (HTML tags and attributes, Svelte elements like `<svelte:window>`, directives like `bind:value`, `{#if}`, `{#each}`, `{@render}` style blocks, and a component's props after `<Icon `), errors, hover, go to definition, also across `.ts` files. Needs `svelte` installed in the project. |
| `<style lang="less">` | Highlighting |
| The whole file | Errors for the [block rules](02-component-files.md#block-rules) |

## Typed Class Names

In `<react>`, `$style` holds the class names of `<style module>`: completion lists them, and go to definition jumps to the class. A named module, `module="classes"`, is `classes` instead. In `<vue>` and `<svelte>`, `$style` is typed too, and a class name the module lacks is an error.

`Card.ucf`

```vue
<style module lang="scss">
.card { padding: 1rem; }
</style>

<react lang="tsx">
export default function Card({ title }: { title: string }) {
  return <div className={$style.card}><h2>{title}</h2></div>
}
</react>
```

> **Tip:** In `<react>`, a `lang="scss"` or `lang="less"` module gets its class names only when the project has `vue` and that preprocessor (`sass`, `less`) installed. Otherwise `$style` accepts any name.

## Component Types in Importing Files

A file that imports a `.ucf` file gets the component its import picks: React in a `.tsx` file, Vue in a `.vue` file, a Svelte `Component` for a svelte pick in a `.ts` file. Hover, go to definition and type errors work there. An unsaved edit in the `.ucf` file shows there at once.

`App.tsx`

```tsx
import Card from '../../../components/Card.ucf';

export default function App() {
  return <Card title="Hello" />;
}
```

> **Tip:** A `.ts` file needs a default framework to get types for a plain import. Set it in `tsconfig.json`, see [Setting the Default Framework](04-imports.md#setting-the-default-framework).

## Svelte Files

Svelte's editor and `svelte-check` read a `.ucf` import from a declaration file. Each time you save a `.ucf` file with a `<svelte>` block, the extension writes one for every such file of the workspace folder, under its `.ucf/svelte/`, at the same path: `src/Card.ucf` gets `.ucf/svelte/src/Card.ucf.d.ts`. Point TypeScript there with `rootDirs`, and keep the folder out of git.

`tsconfig.json`

```json
{
  "compilerOptions": {
    "rootDirs": ["./src", "./.ucf/svelte/src"]
  }
}
```

`.gitignore`

```bash
.ucf/
```

Then `App.svelte` gets Svelte types for `Panel`, and a wrong prop is an error:

```svelte
<script lang="ts">
  import Panel from '../../../components/Panel.ucf';
</script>

<Panel heading="Imported panel" />
```

> **Tip:** The declarations are as fresh as the last save. On CI, write them before `svelte-check`: `node -e "import('@multifront/language-tools').then((tools) => tools.emitSvelteTypes({root: '.'}))" && svelte-check`.

## Formatting and Linting in VS Code

Format Document formats a `.ucf` file exactly as `mf-fmt` does, and oxlint findings show in each framework block as you type, as `mf-lint` reports them. Both use the `oxfmt` and `oxlint` installed in the project, see [Installing the Check Commands](#installing-the-check-commands). When nothing shows, VS Code's Output panel says why, under multifront.

> **Tip:** To format on save, turn on `editor.formatOnSave`. The extension is already the default formatter of `.ucf` files.

## Colors Outside VS Code

GitHub, docs sites built on Shiki and editors without the extension do not know `.ucf` files. Have them read the file as Vue: Vue's highlighter colors each block by its `lang`.

`.gitattributes`

```
*.ucf linguist-language=Vue
```

In Markdown, open a `.ucf` example with ` ```vue `.

> **Note:** In another editor, map `*.ucf` to Vue for colors only. Vue's language tools would report errors a `.ucf` file does not have.

## Installing the Check Commands

The three commands come with `@multifront/language-tools`. Each one runs a tool the project installs:

| Package | Version | For |
| --- | --- | --- |
| `@multifront/language-tools` | the same as `@multifront/vite` | `mf-tsc`, `mf-lint` and `mf-fmt` |
| `typescript` | `^6.0.0` | `mf-tsc` |
| `oxlint` | `^1.82.0` | `mf-lint` |
| `oxfmt` | `>=0.67.0 <1` | `mf-fmt` |
| `svelte` | `^5.55.6` | `mf-tsc` on `<svelte>` blocks, and `mf-fmt` with Svelte formatting on |

## Type-Checking Every Framework

`mf-tsc` type-checks each block of a `.ucf` file in its own framework, with the `.ts`, `.tsx` and `.vue` files that import it. A block that breaks one framework fails the run, even when no file imports that framework.

`SvelteBreaks.ucf`

```vue
<svelte lang="html">
<script lang="ts">
  let { label }: { label: string } = $props()
</script>
<span>{label.toFixed(2)}</span>
</svelte>
```

```bash
pnpm exec mf-tsc SvelteBreaks.ucf
```

```
SvelteBreaks.ucf:20:16: error TS2551 (svelte): Property 'toFixed' does not exist on type 'string'. Did you mean 'fixed'?
mf-tsc: checked 1 file with tsconfig.json: 1 error
```

> **Tip:** `mf-tsc` does not check `.svelte` files. Run `svelte-check` for them, as [Svelte Files](#svelte-files) shows.

## Linting

`mf-lint` lints the `<react>`, `<vue>` and `<svelte>` blocks with oxlint and your `.oxlintrc.json`, and prints each finding at its line in the `.ucf` file. `$style` and named style modules count as defined; `<style>` blocks are not linted.

`.oxlintrc.json`

```json
{
  "rules": {
    "no-debugger": "error",
    "no-undef": "error"
  },
  "overrides": [{"files": ["**/*.tsx"], "rules": {"no-debugger": "warn"}}]
}
```

With it, `mf-lint` in a folder whose `Lint.ucf` has a `debugger;` in each block prints:

```
Lint.ucf:4:9: warning eslint(no-unused-vars) (react): Variable 'unused' is declared but never used. Unused variables should start with a '_'.
Lint.ucf:5:3: warning eslint(no-debugger) (react): `debugger` statement is not allowed
Lint.ucf:13:1: error eslint(no-debugger) (vue): `debugger` statement is not allowed
Lint.ucf:25:3: error eslint(no-debugger) (svelte): `debugger` statement is not allowed
mf-lint: linted 2 files: 2 errors, 2 warnings
```

> **Tip:** Warnings alone exit with code 0. Add `--deny-warnings` to fail on them too.

## Formatting

`mf-fmt` formats each block of a `.ucf` file in place, with oxfmt and your `.oxfmtrc.json`. The tags and the text between blocks stay as written.

`Messy.ucf` before and after `mf-fmt Messy.ucf`

```vue
<style   module lang="scss">
$gap:4px;
.messy{padding:$gap;  &:hover{opacity:.8}}
</style>
```

```vue
<style   module lang="scss">
$gap: 4px;
.messy {
  padding: $gap;
  &:hover {
    opacity: 0.8;
  }
}
</style>
```

`mf-fmt --check` writes nothing and exits with code 1 when a file is not formatted, for CI:

```
Messy.ucf:3:9: error unformatted: not formatted; run mf-fmt Messy.ucf
mf-fmt: 1 of 1 files not formatted
```

| Block | Formatted |
| --- | --- |
| `<react>`, `<vue>` | Always |
| `<style>`, `<style lang="scss">`, `<style lang="less">` | Always |
| `<svelte>` | Only when `.oxfmtrc.json` sets `"svelte": true` and the project has `svelte` installed |
| `<style lang="stylus">` and other style languages | Never, they stay as written |

> **Tip:** `mf-fmt` writes the code of each block it formats flush left, so code indented under its tag loses that indent.

## Picking What to Check

Each command takes files or folders. A file is checked once, however many times you name it.

| Paths | `mf-tsc` checks | `mf-lint` and `mf-fmt` check |
| --- | --- | --- |
| None | The project of the nearest `tsconfig.json` above the current folder, with the projects it references | Every `.ucf` file under the current folder |
| A file | That file | That `.ucf` file |
| A folder | Its files, without `node_modules` and dot folders | Its `.ucf` files, without `node_modules` and dot folders |

`mf-tsc --framework svelte` checks only the `<svelte>` blocks, and `-p <file>` picks the `tsconfig.json`. Each command uses the config nearest above each file: `tsconfig.json`, `.oxlintrc.json` or `.oxfmtrc.json`. `--help` lists every option.

> **Tip:** In a config's `overrides`, a `<react>` block matches `*.tsx`, a `<vue>` block `*.vue`, a `<svelte>` block `*.svelte` and a style block its `lang`, `*.scss` say.

## Output for Scripts and Coding Agents

`--format json` prints one JSON document in the shape of [mf-build's](06-building-a-library.md#output-for-scripts-and-coding-agents), with the same exit codes: 0 no errors, 1 errors found, 2 the command could not run. A coding agent checks the one file and framework it just changed:

```bash
pnpm exec mf-tsc SvelteBreaks.ucf --framework svelte --format json
```

A finding in a `.ucf` file names its `block` and `framework`. The document also holds `projects` from `mf-tsc`, `files` from `mf-lint`, and `files` and `changed` from `mf-fmt`.
