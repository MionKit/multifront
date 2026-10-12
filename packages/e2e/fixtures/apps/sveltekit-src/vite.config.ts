import {sveltekit} from '@sveltejs/kit/vite';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [multifront(), sveltekit()]});
