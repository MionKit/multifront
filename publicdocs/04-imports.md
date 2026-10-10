# Imports

A `.ucf` file holds several frameworks, so each import of it picks one.

## Imports Inside a Component

An import in `<react>` always gets the React component. So the imported file needs a `<react>` block, and the import takes no `framework` attribute.

`Profile.ucf`

```html
<react>
  import Badge from '../Badge.ucf'
  import Card from '../Card.ucf'

  export default function Profile() {
    return <section><Card title="Ada" /><Badge label="Admin" /></section>
  }
</react>
```

## Picking the Framework

Outside a `.ucf` file, the first rule that applies picks the framework of a `.ucf` import.

| Rule | Picks |
| --- | --- |
| 1. The import's `framework` attribute | `vue`, `react` or `svelte` |
| 2. The importing file's extension | react for `.tsx` and `.jsx`, vue for `.vue`, svelte for `.svelte` |
| 3. The [`framework` option](#setting-the-default-framework) | its value |
| None of these | the error `no-target` |

The attribute works on `import`, `export ... from` and `import()`:

```ts
import Card from '../../../components/Card.ucf' with {framework: 'react'};
export {default as VueCard} from '../../../components/Card.ucf' with {framework: 'vue'};
export const SvelteCard = await import('../../../components/Card.ucf', {with: {framework: 'svelte'}});
```

> **Note:** The editor has types for React components only. An import that picks vue or svelte shows the error `target-not-built`.

> **Tip:** In one file, TypeScript gives every import of the same path the type of the last one. To use a component as two frameworks, import each from its own small file that re-exports it.

## Setting the Default Framework

Add the multifront entry to `compilerOptions.plugins` in `tsconfig.json`. The VS Code extension loads the plugin itself, so the entry only holds its options.

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "plugins": [{"name": "@multifront/language-tools/typescript-plugin", "framework": "react"}]
  },
  "include": ["src"]
}
```

| Option | Does | Example |
| --- | --- | --- |
| `framework` | Picks the framework when no other rule does, as for a bare import in a `.ts` file | `"react"` |
| `importers` | Picks a framework by the importing file's extension, over the defaults of rule 2 | `{".ts": "svelte", ".tsx": "vue"}` |
