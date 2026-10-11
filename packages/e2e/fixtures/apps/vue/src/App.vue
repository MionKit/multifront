<script setup lang="ts">
import Counter from '../../../components/Counter.ucf';
import VBind from '../../../components/vue/VBind.ucf';
import Plain from './Plain.vue';
</script>

<template>
  <Counter :start="2" />
  <VBind />
  <Plain />
</template>
