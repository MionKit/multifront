import vue from '@vitejs/plugin-vue';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [vue(), multifront()]});
