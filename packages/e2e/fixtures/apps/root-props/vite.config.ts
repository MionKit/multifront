import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [react(), vue(), svelte(), multifront()]});
