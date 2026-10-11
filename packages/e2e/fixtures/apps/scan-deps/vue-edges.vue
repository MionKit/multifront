<!-- `<vue>` blocks the scan cannot compile are skipped, and the others still scanned. -->
<script setup lang="ts">
import MixedLang from './MixedLang.ucf';
import Mount from './Mount.ucf';
import TemplateOnly from './TemplateOnly.ucf';
</script>

<template>
  <TemplateOnly />
  <MixedLang />
  <Mount />
</template>
