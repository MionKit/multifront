<script setup lang="ts">
const label = 'Plain';
</script>

<template>
  <p class="plain" :class="$style.note">{{ label }}</p>
</template>

<style scoped>
.plain {
  font-weight: bold;
}
</style>

<style module>
.note {
  font-style: italic;
}
</style>
