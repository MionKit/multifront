<!-- `<vue>` blocks the scan cannot compile are skipped, and the others still scanned. -->
<script setup lang="ts">
import MixedLang from './MixedLang.front';
import Mount from './Mount.front';
import TemplateOnly from './TemplateOnly.front';
</script>

<template>
  <TemplateOnly />
  <MixedLang />
  <Mount />
</template>
