import {sveltekit} from '@sveltejs/kit/vite';
import {defineConfig} from 'vite';

// Computed: SvelteKit's client build reloads this file via Vite's bundler, which resolves a literal import to `dist/`.
const {multifront} = await import(['@multifront', 'vite'].join('/'));

export default defineConfig({plugins: [multifront(), sveltekit()]});
