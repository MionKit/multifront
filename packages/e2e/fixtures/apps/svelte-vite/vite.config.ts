import {svelte} from '@sveltejs/vite-plugin-svelte';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [svelte(), multifront()]});
