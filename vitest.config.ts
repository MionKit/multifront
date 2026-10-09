import {defineConfig} from 'vitest/config';

// The single list of test projects: one per package, each with its own vitest.config.ts.
export default defineConfig({
  resolve: {conditions: ['source']},
  ssr: {resolve: {conditions: ['source']}},
  test: {
    projects: ['packages/core/vitest.config.ts', 'packages/e2e/vitest.config.ts', 'packages/vite/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**'],
    },
  },
});
