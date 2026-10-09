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

<style module>
.card { padding: 1rem; }
</style>
```

> **Status:** early development, nothing published yet. See the [spec](docs/spec.md) and the [plan](docs/plan.md).

## Packages

| Package | What it does |
| --- | --- |
| [@multifront/core](packages/core/) | The compiler: splits the file, compiles the styles, transforms each target. |
| [@multifront/vite](packages/vite/) | Vite plugin, built on `@vitejs/plugin-vue`. |
| [@multifront/runtime](packages/runtime/) | Tiny helpers the compiled components import. |

## Develop

```bash
pnpm install
pnpm devx check     # format check, lint, typecheck, test, build
```

Setup and every command: [SETUP.md](SETUP.md).

## License

MIT
