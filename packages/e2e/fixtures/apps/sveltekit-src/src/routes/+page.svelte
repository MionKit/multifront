<script lang="ts">
  import { onMount } from 'svelte';
  import Panel from '../../../../components/Panel.front';
  import Counter from '../../../../components/Counter.front' with { framework: 'svelte' };

  onMount(() => {
    document.body.dataset.hydrated = 'true';
  });
</script>

<Panel heading="Kit panel" />
<Counter start={2} />
<a href="/items">Items</a>
