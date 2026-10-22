<script setup lang="ts">
import Counter from '../../../components/Counter.front';
import VBind from '../../../components/vue/VBind.front';
import UsesIcon from '../../../components/imports/UsesIcon.front' with { framework: 'vue' };
import Plain from './Plain.vue';
</script>

<template>
  <Counter :start="2" />
  <VBind />
  <UsesIcon />
  <Plain />
</template>
