# Editor Setup

The VS Code extension makes VS Code understand `.ucf` files, and gives `.ts`, `.tsx` and `.vue` files the types of the components they import.

## Installing the VS Code Extension

Build the extension from the multifront repository, then install the `.vsix` file it writes. The build needs the tools listed in [SETUP.md](../SETUP.md).

```bash
git clone https://github.com/MionKit/multifront.git
cd multifront
pnpm install
pnpm devx vsix
code --install-extension packages/vscode/multifront-vscode-0.0.0.vsix
```

It brings everything it needs. Only `.vue` files that import a `.ucf` file also need the [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) extension, installed before or after this one.

## Editor Features per Block

Open a `.ucf` file and each block gets its own language's features.

| Block | In the editor |
| --- | --- |
| `<react>` | Highlighting, completions, errors, hover, go to definition, rename and find references, also across `.ts` and `.tsx` files |
| `<style>`, `<style lang="scss">` | Highlighting, completions, errors, hover, go to definition |
| `<vue>` | Highlighting, completions (template tags, attributes and directives too), errors, hover, go to definition, rename and find references, also across `.ts` files |
| `<svelte>`, `<style lang="less">` | Highlighting |
| The whole file | Errors for the [block rules](02-component-files.md#block-rules) |

## Typed Class Names

In `<react>`, `$style` holds the class names of `<style module>`: completion lists them, and go to definition jumps to the class. A named module, `module="classes"`, is `classes` instead. In `<vue>`, `$style` is typed too, and a class name the module lacks is an error.

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

A file that imports a `.ucf` file gets the component its import picks: React in a `.tsx` file, Vue in a `.vue` file. Hover, go to definition and type errors work there. An unsaved edit in the `.ucf` file shows there at once.

`App.tsx`

```tsx
import Card from '../../../components/Card.ucf';

export default function App() {
  return <Card title="Hello" />;
}
```

> **Tip:** A `.ts` file needs a default framework to get types for a plain import. Set it in `tsconfig.json`, see [Setting the Default Framework](04-imports.md#setting-the-default-framework).
