# multifront

Write one component file with a Vue, React and Svelte version, plus shared styles. Build it into one package per framework.

```html
<vue>
  <template><div :class="$style.card"><slot /></div></template>
</vue>

<react>
  export default function Card({children}) {
    return <div className={$style.card}>{children}</div>
  }
</react>

<svelte>
  <script lang="ts">
  import type {Snippet} from 'svelte'
  let {children}: {children?: Snippet} = $props()
  </script>
  <div class={$style.card}>{@render children?.()}</div>
</svelte>

<style module>
.card { padding: 1rem; }
</style>
```

> **Status:** early development, nothing published yet. See the [spec](docs/spec.md), the [architecture](docs/architecture.md) and the [plan](docs/plan.md).

## Packages

| Package | What it does |
| --- | --- |
| [@multifront/core](packages/core/) | The compiler: splits the file, compiles the styles, transforms each target. |
| [@multifront/vite](packages/vite/) | Vite plugin: hands each target to `@vitejs/plugin-vue`, `@vitejs/plugin-react` or `@sveltejs/vite-plugin-svelte`. Builds the per-framework packages (`mf-build`). |
| [@multifront/language-tools](packages/language-tools/) | Editor tooling: the Volar language plugin for the TypeScript plugin and the language server. |

## Develop

```bash
pnpm install
pnpm devx check     # format check, lint, typecheck, test, build
```

Setup and every command: [SETUP.md](SETUP.md).

## License

MIT
