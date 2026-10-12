import {join} from 'node:path';
import {startServer} from '@multifront/language-tools/server';
import {HOST_TYPESCRIPT} from './bundle/hostTypeScript.ts';

// Bundled, svelte2tsx's shims sit beside the bundle, and its `typescript` import is the tsdk's copy.
startServer({
  svelteTypesRoot: join(import.meta.dirname, 'svelte-types'),
  onTypeScript: (ts) => {
    (globalThis as {[HOST_TYPESCRIPT]?: unknown})[HOST_TYPESCRIPT] = ts;
  },
});
