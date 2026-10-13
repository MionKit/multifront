import {defineLibrary} from '@multifront/vite';

export default defineLibrary({
  packages: {react: {name: '@mf-fixture/ui-react'}, vue: {name: '@mf-fixture/ui-vue'}, svelte: {name: '@mf-fixture/ui-svelte'}},
});
