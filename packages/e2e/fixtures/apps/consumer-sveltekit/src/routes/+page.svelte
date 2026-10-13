<script lang="ts">
  import {onMount} from 'svelte';
  import {Button, Card, Counter} from '@mf-fixture/ui-svelte';

  let clicks = $state(0);
  // Runs only once the page has hydrated: the spec clicks after this mark.
  onMount(() => {
    document.body.dataset.hydrated = '';
  });
</script>

<main>
  <Card title="Hello">
    <Counter />
  </Card>
  <Button label="Go" onclick={() => clicks++} />
  <output id="clicks">{clicks}</output>
</main>
