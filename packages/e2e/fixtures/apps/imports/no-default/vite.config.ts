import react from '@vitejs/plugin-react';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [react(), multifront({importers: {'.mts': 'vue'}})]});
