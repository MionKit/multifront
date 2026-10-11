# Styles

The `<style>` blocks of a `.ucf` file style every framework block in it.

## Style Blocks

Each `<style>` block works as in [Vue's `<style>`](https://vuejs.org/api/sfc-spec.html#style), with `scoped`, `module` and `lang`. In `<vue>` they work exactly as in a `.vue` file, and `v-bind()` works there only.

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

| Block | In `<react>` |
| --- | --- |
| `<style>` | Global CSS |
| `<style scoped>` | Styles only the elements this file renders |
| `<style module>` | Class names in `$style` |
| `<style module="classes">` | Class names in `classes` |

## Same Look in Every Framework

The Vue and the React component of one file get the same scoped `data-v-*` attribute and the same `$style` class names. So they look the same, also side by side in one app.

## Styling a Child Component

A parent's scoped style reaches the root element of a child `.ucf` component, as in Vue, but not the elements inside it. Here `.badge` colors the badge's `<span>`, and `.badge-label` misses its `<em>`.

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

What the child returns decides whether its root gets the parent's style:

| The child returns | Gets the parent's scoped style |
| --- | --- |
| An element, also through `?:`, `&&`, `memo` or `forwardRef` | Yes |
| Another `.ucf` component | Yes, on that component's root |
| A fragment, `<>...</>` | No, and a warning in the dev console |
| `null`, text, `children` or a function call | No |
