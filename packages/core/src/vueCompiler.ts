import {createRequire} from 'node:module';
import type {VueCompiler} from './types.ts';

const require = createRequire(import.meta.url);

/** Same lookup order as plugin-vue, so a host without it still gets the compiler the project's Vue ships. */
export function loadVueCompiler(root: string): VueCompiler {
  for (const id of ['vue/compiler-sfc', '@vue/compiler-sfc']) {
    try {
      return require(require.resolve(id, {paths: [root]})) as VueCompiler;
    } catch {
      continue;
    }
  }
  throw new Error('multifront: could not find @vue/compiler-sfc. Install vue or @vue/compiler-sfc in your project.');
}
