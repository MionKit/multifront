import vue from '@vitejs/plugin-vue';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [vue()],
  // styles: a page that imports the combined styles.css, beside the main page that relies on per-component CSS.
  build: {rolldownOptions: {input: {main: 'index.html', styles: 'styles.html'}}},
});
