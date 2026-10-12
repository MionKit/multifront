<script module lang="ts">
  export { default as Card } from '../../../components/Card.ucf' with { framework: 'svelte' };
</script>

<script lang="ts">
  import Panel from '../../../components/Panel.ucf';
  import Counter from '../../../components/Counter.ucf' with { framework: 'svelte' };

  const lazy = import('../../../components/imports/UsesIcon.ucf', { with: { framework: 'svelte' } });
</script>

<Panel heading="Imported panel" />
<Counter start={2} />
{#await lazy then { default: UsesIcon }}<UsesIcon />{/await}
