# Styles

The `<style>` blocks of a `.ucf` file style every framework block in it.

## Style Blocks

Each `<style>` block works as in [Vue's `<style>`](https://vuejs.org/api/sfc-spec.html#style), with `scoped`, `module` and `lang`, `:deep()` and `:global()`, the same in every framework. In `<vue>` they work exactly as in a `.vue` file.

`AllBlocks.ucf`

```html
<react>
  export default function AllBlocks() {
    return (
      <div className={$style.card}>
        <p className={classes.title}>All blocks</p>
        <p className="all-blocks-global">all-blocks-react-marker</p>
      </div>
    )
  }
</react>

<style module="classes">
.title {
  color: rgb(20, 90, 160);
}
</style>
```

| Block | In `<react>` and `<svelte>` |
| --- | --- |
| `<style>` | Global CSS |
| `<style scoped>` | Styles only the elements this file renders |
| `<style module>` | Class names in `$style` |
| `<style module="classes">` | Class names in `classes`, or `$classes` in `<svelte>` |

## Vue-Only Features

`v-bind()` in CSS and `:slotted()` in a `<style scoped>` work in `<vue>` only. A file with a `<react>` or `<svelte>` block that uses them fails to build for those frameworks ([`vue-only-style`](07-errors.md#component-file-errors)), so no framework renders without them.

Use a CSS variable in their place. `Vars.ucf`:

```html
<style scoped>
.vars {
  color: var(--accent, rgb(1, 2, 3));
}
</style>
```

> **Tip:** A parent sets the variable through `style`: `style="--accent: rgb(200, 0, 0)"`, or `style={{ '--accent': 'rgb(200, 0, 0)' }}` in `<react>`.

## Same Look in Every Framework

The Vue, React and Svelte components of one file get the same scoped `data-v-*` attribute and the same `$style` class names. So they look the same, also side by side in one app.

## Styling a Child Component

A parent's scoped style reaches the root element of a child `.ucf` component, as in Vue, but not the elements inside it. This works in every framework. Here `.badge` colors the badge's `<span>`, and `.badge-label` misses its `<em>`.

`ScopedPanel.ucf`

```html
<react>
  import ScopedBadge from './ScopedBadge.ucf'

  export default function ScopedPanel() {
    return (
      <section className="panel">
        <h2 className="title">Scoped panel</h2>
        <ScopedBadge label="new" className="badge" />
      </section>
    )
  }
</react>

<style scoped>
.badge {
  color: rgb(30, 120, 60);
}
/* Must not reach ScopedBadge's inner element. */
.badge-label {
  text-decoration: underline;
}
</style>
```

`ScopedBadge.ucf`

```html
<react>
  type Props = { label: string; className?: string }

  export default function ScopedBadge({label, className = ''}: Props) {
    return <span className={className}><em className="badge-label">{label}</em></span>
  }
</react>
```

What the child renders decides whether its root gets the parent's style:

| The child renders | Gets the parent's scoped style and its `class` / `className` and `style` props |
| --- | --- |
| `<react>`: an element, also through `?:`, `&&`, `memo` or `forwardRef` | Yes |
| `<svelte>`: one element, also one per `{#if}`, `{#key}`, `{#await}` or `<svelte:boundary>` branch | Yes |
| Another `.ucf` component | Yes, on that component's root |
| `<react>`: a fragment, `<>...</>` | No, and a warning in the dev console |
| `<svelte>`: more than one root, an `{#each}` root, or legacy syntax such as `export let` | No, and a warning in the dev console |
| `<react>`: `null`, text, `children` or a function call | No |
| `<svelte>`: text, `{@render}`, `{@html}` or `<slot>` | No |

> **Tip:** A `<svelte>` child that is only markup passes nothing on, with no warning. Add `<svelte:options runes />` or a script with `$props()`.
