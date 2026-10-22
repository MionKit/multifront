<script lang="ts">
  import type {Snippet} from 'svelte'

  let {children, label, ...rest}: {children?: Snippet; label?: string; [key: string]: unknown} = $props()
  // Only the scope attribute, class and style reach the root, as on a `.front` root: the other props are not attributes.
  const attrs = $derived(
    Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-v-') || key === 'class' || key === 'style'))
  )
</script>
<b {...attrs}>{label}{@render children?.()}</b>
