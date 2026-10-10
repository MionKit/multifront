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

## Block Rules

The editor marks each broken rule as an error. [Errors](07-errors.md) says how to fix each one.

- Only `<vue>`, `<react>`, `<svelte>` and `<style>` at the top level. Text between blocks goes in an HTML comment.
- At least one of `<vue>`, `<react>` and `<svelte>`, each at most once. Any number of `<style>` blocks.
- Every block has its closing tag: `<react/>` is not a block.
- `<react>` exports the component as default.
- `<react>` code parses as TSX, and its `.ucf` imports carry no `framework` attribute: they always get react.
- `<style>` sits at the top level, never inside `<vue>` or `<svelte>`.
- `lang` is `css`, `scss`, `sass`, `less`, `styl`, `stylus` or `postcss`.
- Two `<style module>` blocks need two names, for example `module` and `module="classes"`.

> **Tip:** `</react>` in the `<react>` code ends the block, even inside a string. Write `<\/react>` there instead.
