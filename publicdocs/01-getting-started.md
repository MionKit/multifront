# Getting Started

Add the multifront Vite plugin to a React app, then import `.ucf` files like any React component.

## Setting Up Vite

Add `multifront()` from `@multifront/vite` to the plugins, next to `react()`.

`vite.config.ts`

```ts
import react from '@vitejs/plugin-react';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [react(), multifront()]});
```

The app also needs these packages:

| Package | Version | For |
| --- | --- | --- |
| `vite` | `^8.0.0` | the build |
| `@vitejs/plugin-react` | `^6.0.0` | compiling the `<react>` block |
| `react`, `react-dom` | `^19.0.0` | rendering it |
| `vue` or `@vue/compiler-sfc` | `^3.5.15` | compiling the `<style>` blocks |

## Writing a First Component

Write the component in a `<react>` block, with its styles beside it.

`Counter.ucf`

```html
<react>
  import { useState } from 'react'

  export default function Counter({start = 0}: {start?: number}) {
    const [count, setCount] = useState(start)
    return (
      <div className="counter">
        <button className={$style.button} onClick={() => setCount(count + 1)}>{count}</button>
      </div>
    )
  }
</react>

<style scoped>
.counter {
  color: rgb(120, 40, 160);
}
</style>

<style module>
.button {
  padding: 4px 12px;
}
</style>
```

Then import it from a `.tsx` file. [Imports](04-imports.md) says how other files pick the framework.

`App.tsx`

```tsx
import Counter from '../../../components/Counter.ucf';

export default function App() {
  return (
    <>
      <section data-demo="counter">
        <Counter />
      </section>
    </>
  );
}
```

> **Note:** The component works the same in the dev server, the production build and server rendering with `react-dom/server`.

## Editing While the Dev Server Runs

An edit to a `.ucf` file updates only what changed, so the component keeps its state.

| You edit | The page |
| --- | --- |
| A `<style>` block | Swaps that CSS only |
| The `<react>` block | Updates the component with React Fast Refresh |
| A `<vue>` or `<svelte>` block | Does not change |
