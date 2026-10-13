<!-- Type checked, never bundled. -->
<script setup lang="ts">
import {Card} from '@mf-fixture/ui-vue';
</script>

<template>
  <!-- @vue-expect-error Card takes `title`, not `titel`. -->
  <Card titel="x" />
</template>
