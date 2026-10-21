# Getting Started

Add the multifront Vite plugin to a React, Vue or Svelte app, then import `.ucf` files like any other component.

## Setting Up Vite

Add `multifront()` from `@multifront/vite` to the plugins, next to `react()`, `vue()`, `svelte()` or all three.

`vite.config.ts`

```ts
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [react(), vue(), svelte(), multifront()]});
```

The app also needs these packages:

| Package | Version | For |
| --- | --- | --- |
| `vite` | `^8.0.0` | every app |
| `vue` or `@vue/compiler-sfc` | `^3.5.15` | every app, to compile the `<style>` blocks |
| `@vitejs/plugin-react` | `^6.0.0` | React apps |
| `react`, `react-dom` | `^19.0.0` | React apps |
| `@vitejs/plugin-vue` | `^6.0.3` | Vue apps |
| `@sveltejs/vite-plugin-svelte` | `^7.1.1` | Svelte apps |
| `svelte` | `^5.55.6` | Svelte apps |

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

## Adding a Vue Version

Add a `<vue>` block to the same file. It shares the `<style>` blocks, so `$style.button` and the scoped `.counter` style it too.

`Counter.ucf`

```html
<vue>
<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{start?: number}>()
const count = ref(props.start ?? 0)
</script>

<template>
  <div class="counter">
    <button :class="$style.button" @click="count++">{{ count }}</button>
  </div>
</template>
</vue>
```

Then import it from a `.vue` file.

`App.vue`

```vue
<script setup lang="ts">
import Counter from '../../../components/Counter.ucf';
</script>

<template>
  <Counter :start="2" />
</template>
```

## Adding a Svelte Version

Add a `<svelte>` block to the same file. It is a Svelte 5 component and shares the `<style>` blocks too.

`Counter.ucf`

```html
<svelte>
<script lang="ts">
  import { untrack } from 'svelte'

  let { start = 0 }: { start?: number } = $props()
  let count = $state(untrack(() => start))
</script>

<div class="counter">
  <button class={$style.button} onclick={() => count++}>{count}</button>
</div>
</svelte>
```

Then import it from a `.svelte` file.

`App.svelte`

```svelte
<script lang="ts">
  import Counter from '../../../components/Counter.ucf' with { framework: 'svelte' };
</script>

<Counter start={2} />
```

> **Note:** All three versions work the same in the dev server, the production build and server rendering, with `react-dom/server`, `vue/server-renderer` or `svelte/server`.

## Using SvelteKit

Add `multifront()` before `sveltekit()`. Pages built from `.ucf` files render on the server and hydrate with the same scoped styles.

`vite.config.ts`

```ts
import {sveltekit} from '@sveltejs/kit/vite';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [multifront(), sveltekit()]});
```

## Editing While the Dev Server Runs

An edit to a `.ucf` file updates only the components it changes.

| You edit | React component | Vue component | Svelte component |
| --- | --- | --- | --- |
| A `<style>` block | Swaps that CSS only | Swaps that CSS only | Swaps that CSS only |
| The `<react>` block | Updates with React Fast Refresh | Does not change | Does not change |
| The `<vue>` block | Does not change | Updates as a `.vue` file does: a `<template>` edit keeps the state | Does not change |
| The `<svelte>` block | Does not change | Does not change | Updates without a page reload |
