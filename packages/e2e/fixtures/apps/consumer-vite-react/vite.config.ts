import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react()],
  // only-card: an entry that imports Card alone, so its bundle shows what `sideEffects` lets the bundler drop.
  build: {rolldownOptions: {input: {main: 'index.html', 'only-card': 'src/only-card.tsx'}}},
});
