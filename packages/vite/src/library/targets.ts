import type {Target} from '@multifront/core';
import type {LibraryTarget} from '../types.ts';
import {emitReactTypes, emitSvelteTypes, emitVueTypes} from './dts.ts';

// Imported on use: the framework plugins are optional peers of this package.
export const libraryTargets = {
  react: {
    plugin: async () => (await import('@vitejs/plugin-react')).default(),
    peers: {react: '^19.0.0', 'react-dom': '^19.0.0'},
    useClient: true,
    emitTypes: emitReactTypes,
  },
  vue: {
    plugin: async () => (await import('@vitejs/plugin-vue')).default(),
    peers: {vue: '^3.5.0'},
    emitTypes: emitVueTypes,
  },
  // svelte-package's layout: uncompiled `.svelte` files, the consumer's Svelte compiles them.
  svelte: {
    // `<style>` ships inside each `.svelte` source: the compiled, dropped code must add no CSS to the CSS step.
    plugin: async () => (await import('@sveltejs/vite-plugin-svelte')).svelte({emitCss: false}),
    // 5.16: shipped roots merge class values with Svelte's own clsx and type them with its `ClassValue`.
    peers: {svelte: '^5.16.0'},
    conditions: ['svelte'],
    sourceExt: '.svelte',
    emitTypes: emitSvelteTypes,
  },
} satisfies Record<Target, LibraryTarget>;
