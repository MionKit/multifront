# Component Files

A `.ucf` file holds one component, written once per framework, plus the styles they share.

## Blocks

Each block holds what you would write in that framework's own file. Write only the frameworks you need: one block is enough.

`Card.ucf`

```html
<vue>
<script setup lang="ts">
defineProps<{ title: string }>()
</script>
<template>
  <div :class="$style.card"><h2>{{ title }}</h2></div>
</template>
</vue>

<react>
export default function Card({ title }: { title: string }) {
  return <div className={$style.card}><h2>{title}</h2></div>
}
</react>

<svelte>
<script lang="ts">
  let { title }: { title: string } = $props()
</script>
<div class={$style.card}><h2>{title}</h2></div>
</svelte>

<style module lang="scss">
.card { padding: 1rem; }
</style>
```

| Block | Holds |
| --- | --- |
| `<vue>` | The inside of a `.vue` file: `<script setup>` and `<template>`, no `<style>` |
| `<react>` | A TSX module that exports the component as default |
| `<svelte>` | The inside of a `.svelte` file, no `<style>` |
| `<style>` | CSS for every block. `scoped`, `module` and `lang` work as in [Vue's `<style>`](https://vuejs.org/api/sfc-spec.html#style) |

## Class, Style and Ref on Components

Every `<react>` component passes the `className`, `style` and `ref` its parent gives on to its root element, and every `<svelte>` component the `class` and `style`: the same root a parent's [scoped style](03-styles.md#styling-a-child-component) reaches. The editor and a [library's](06-building-a-library.md) `.d.ts` files type them, `ref` for the root's tag. A Vue component does the same on its own.

`Button.ucf`

```html
<react>
import type { MouseEventHandler } from 'react'
import { cx } from './utils/cx.js'

export default function Button({ label, onClick }: { label: string; onClick?: MouseEventHandler<HTMLButtonElement> }) {
  return <button className={cx($style.button)} style={{ fontWeight: 600 }} onClick={onClick}>{label}</button>
}
</react>
```

`App.tsx`

```tsx
import {useRef} from 'react';
import Button from '../../../library/src/Button.ucf';

export default function App() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <section data-case="button">
      <Button label="Press" className="extra" style={{color: 'red'}} ref={buttonRef} />
    </section>
  );
}
```

| Prop | On the root |
| --- | --- |
| `className` (React), `class` (Svelte) | Joins the root's own classes |
| `style` | Merges with the root's own style; the parent's values win |
| `ref` (React) | Gets the root element, as does the root's own `ref` |

> **Tip:** To place one of these props yourself, read it from the props, as in `({ label, className })` or `let { label, class: klass } = $props()`. multifront then leaves that prop to you.

## Block Rules

The editor marks each broken rule as an error. [Errors](07-errors.md) says how to fix each one.

- Only `<vue>`, `<react>`, `<svelte>` and `<style>` at the top level. Text between blocks goes in an HTML comment.
- At least one of `<vue>`, `<react>` and `<svelte>`, each at most once. Any number of `<style>` blocks.
- Every block has its closing tag: `<react/>` is not a block.
- `<vue>` holds a `<template>` or a `<script>`, as a `.vue` file does.
- `<react>` exports the component as default.
- `<react>` code parses as TSX, `<svelte>` code as Svelte.
- `.ucf` imports in `<react>`, `<vue>` and `<svelte>` carry no `framework` attribute: they get that block's framework.
- In `<svelte>`, `$style` needs a `<style module>`, and `$name` a `<style module="name">` unless the block declares a store `name`.
- `<style>` sits at the top level, never inside `<vue>` or `<svelte>`.
- `lang` is `css`, `scss`, `sass`, `less`, `styl`, `stylus` or `postcss`.
- Two `<style module>` blocks need two names, for example `module` and `module="classes"`.
- `v-bind()` and the `:slotted()` of a `<style scoped>` need a file with no `<react>` or `<svelte>` block.

> **Tip:** `</react>` in the `<react>` code ends the block, even inside a string. Write `<\/react>` there instead.
