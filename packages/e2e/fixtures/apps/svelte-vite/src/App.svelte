<script module lang="ts">
  export { default as Card } from '../../../components/Card.front' with { framework: 'svelte' };
</script>

<script lang="ts">
  import Panel from '../../../components/Panel.front';
  import Counter from '../../../components/Counter.front' with { framework: 'svelte' };

  const lazy = import('../../../components/imports/UsesIcon.front', { with: { framework: 'svelte' } });
</script>

<Panel heading="Imported panel" />
<Counter start={2} />
{#await lazy then { default: UsesIcon }}<UsesIcon />{/await}
