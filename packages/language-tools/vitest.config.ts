import {defineConfig} from 'vitest/config';

export default defineConfig({
  resolve: {conditions: ['source']},
  ssr: {resolve: {conditions: ['source']}},
  test: {
    name: 'language-tools',
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
