# Imports

A `.ucf` file holds several frameworks, so each import of it picks one.

## Imports Inside a Component

An import in `<react>` always gets the React component, one in `<vue>` the Vue component, and one in `<svelte>` the Svelte component. So the imported file needs a block for that framework, and the import takes no `framework` attribute.

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

> **Note:** An import that picks vue needs `@vitejs/plugin-vue` in your Vite plugins, and one that picks svelte needs `@sveltejs/vite-plugin-svelte`, or the build fails. In the editor, TypeScript has types for react and vue picks only: a svelte pick gives the error `target-not-built`.

> **Tip:** In one file, TypeScript gives every import of the same path the type of the last one. To use a component as two frameworks, import each from its own small file that re-exports it.

## Using Both Frameworks in One App

A React app can also render a `.ucf` file as Vue: add `vue()` to its Vite plugins and pick vue in the import.

`mountVue.ts`

```ts
import {createApp} from 'vue';
import Counter from '../../../components/Counter.ucf' with {framework: 'vue'};

createApp(Counter).mount('#vue');
```

## Setting the Default Framework

Pass the options to `multifront()` for the build, and to the TypeScript plugin in `tsconfig.json` for the editor. Give both the same values, so the build and the editor pick the same framework.

`vite.config.ts`

```ts
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [react(), vue(), multifront({framework: 'react'})]});
```

`tsconfig.json`

```json
{
  "compilerOptions": {
    "plugins": [{"name": "@multifront/language-tools/typescript-plugin", "framework": "react"}]
  }
}
```

| Option | Does | Example |
| --- | --- | --- |
| `frameworks` | Limits imports to these frameworks, all three by default; picking another is the error `target-not-enabled` | `["react"]` |
| `framework` | Picks the framework when no other rule does, as for a bare import in a `.ts` file | `"react"` |
| `importers` | Picks a framework by the importing file's extension, over the defaults of rule 2 | `{".ts": "svelte", ".tsx": "vue"}` |

> **Note:** The VS Code extension loads the TypeScript plugin itself, so its `tsconfig.json` entry only holds the options.
