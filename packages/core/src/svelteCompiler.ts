import {createRequire} from 'node:module';
import type {SvelteCompiler} from './types.ts';

const require = createRequire(import.meta.url);

/** The project's own `svelte/compiler`, the copy plugin-svelte compiles with. */
export function loadSvelteCompiler(root: string): SvelteCompiler {
  let path: string;
  try {
    path = require.resolve('svelte/compiler', {paths: [root]});
  } catch {
    throw new Error('multifront: could not find svelte. Install svelte in your project.');
  }
  // Found but broken: its own error says why, not "could not find".
  return require(path) as SvelteCompiler;
}
