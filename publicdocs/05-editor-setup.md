# Editor Setup

The VS Code extension makes VS Code understand `.ucf` files, and gives `.ts`, `.tsx`, `.vue` and `.svelte` files the types of the components they import.

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

```html
<react>
  export default function Card({ title }: { title: string }) {
    return <div className={$style.card}><h2>{title}</h2></div>
  }
</react>

<style module lang="scss">
.card { padding: 1rem; }
</style>
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
