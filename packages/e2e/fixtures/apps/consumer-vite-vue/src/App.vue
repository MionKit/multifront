<script setup lang="ts">
import {ref} from 'vue';
import {Button, Card, Counter} from '@mf-fixture/ui-vue';
// The index exports only components with every framework's block.
import VueOnly from '@mf-fixture/ui-vue/VueOnly';

const clicks = ref(0);
function press(event: MouseEvent): void {
  if (event instanceof MouseEvent) clicks.value++;
}
</script>

<template>
  <main>
    <Card title="Hello">
      <Counter />
    </Card>
    <Button label="Go" class="extra" :style="{color: 'red'}" @click="press" />
    <output id="clicks">{{ clicks }}</output>
    <VueOnly />
  </main>
</template>
