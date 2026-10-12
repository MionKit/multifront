import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vite';

// Computed: svelte-check and Svelte's language server load this file via Vite's bundler, which resolves a literal
// import to `dist/`.
const {multifront} = await import(['@multifront', 'vite'].join('/'));

export default defineConfig({plugins: [svelte(), multifront()]});
