import {defineConfig} from 'vitest/config';

export default defineConfig({
  resolve: {conditions: ['source']},
  ssr: {resolve: {conditions: ['source']}},
  test: {
    name: 'e2e',
    environment: 'node',
    include: ['{build,browser,editor,consumer,devx}/**/*.spec.ts'],
    testTimeout: 60_000,
    // Hooks start real processes (tsserver, the language server): ~8 s under a full run, too near Vitest's 10 s default.
    hookTimeout: 60_000,
    // Node itself loads fixture apps' `vite.config.ts` (`configLoader: 'native'`): this makes it pick our `src/`.
    execArgv: ['--conditions=source'],
  },
});
