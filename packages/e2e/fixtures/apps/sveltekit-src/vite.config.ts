import {sveltekit} from '@sveltejs/kit/vite';
import {defineConfig} from 'vite';

// SvelteKit's client build reloads this file with Vite's bundling loader, which resolves a literal import without the
// `source` condition (to a stale or missing `dist/`); a computed one is left to Node.
const {multifront} = await import(['@multifront', 'vite'].join('/'));

export default defineConfig({plugins: [multifront(), sveltekit()]});
