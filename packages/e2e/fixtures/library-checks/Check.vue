<!-- Built into `<outDir>/vue`, copied to `<outDir>/checks`: it imports the package by relative path. -->
<script setup lang="ts">
import VueOnly from '../vue/VueOnly.js';
import {Button, Card, Counter} from '../vue/index.js';

function press(event: MouseEvent): void {
  event.preventDefault();
}
</script>

<template>
  <Card title="Hello">
    <Counter />
    <Button label="Press" @click="press" />
    <VueOnly />
    <!-- @vue-expect-error `titel` is no prop, and `title` is missing -->
    <Card titel="x" />
    <!-- @vue-expect-error `click` passes a MouseEvent -->
    <Button label="Press" @click="(count: number) => count" />
  </Card>
</template>
