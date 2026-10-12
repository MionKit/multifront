import {createRequire} from 'node:module';
import type {SvelteCompiler, VueCompiler} from './types.ts';

const require = createRequire(import.meta.url);

// The first id the project root resolves, required.
function loadFromRoot(root: string, ids: readonly string[], missing: string): unknown {
  for (const id of ids) {
    let path: string;
    try {
      path = require.resolve(id, {paths: [root]});
    } catch {
      continue;
    }
    // Found but broken: its own error says why, not "could not find".
    return require(path);
  }
  throw new Error(missing);
}

/** Same lookup order as plugin-vue, so a host without it still gets the compiler the project's Vue ships. */
export function loadVueCompiler(root: string): VueCompiler {
  const missing = 'multifront: could not find @vue/compiler-sfc. Install vue or @vue/compiler-sfc in your project.';
  return loadFromRoot(root, ['vue/compiler-sfc', '@vue/compiler-sfc'], missing) as VueCompiler;
}

/** The project's own `svelte/compiler`, the copy plugin-svelte compiles with. */
export function loadSvelteCompiler(root: string): SvelteCompiler {
  const missing = 'multifront: could not find svelte. Install svelte in your project.';
  return loadFromRoot(root, ['svelte/compiler'], missing) as SvelteCompiler;
}
