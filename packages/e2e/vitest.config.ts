import {defineConfig} from 'vitest/config';

export default defineConfig({
  resolve: {conditions: ['source']},
  ssr: {resolve: {conditions: ['source']}},
  test: {
    name: 'e2e',
    environment: 'node',
    include: ['{build,browser,editor,consumer}/**/*.spec.ts'],
    testTimeout: 60_000,
  },
});
