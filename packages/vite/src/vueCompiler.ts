import {createRequire} from 'node:module';
import type {Plugin} from 'vite';
import type {VueCompiler} from './types.ts';

const VUE_PLUGIN_NAME = 'vite:vue';
const require = createRequire(import.meta.url);

interface VuePluginApi {
  options: {compiler?: VueCompiler | null; root: string};
}

/** plugin-vue only resolves its compiler in `buildStart`, so call this from a later hook. */
export function getVueCompiler(plugins: readonly Plugin[], root: string): VueCompiler {
  const vuePlugin = plugins.find((plugin) => plugin.name === VUE_PLUGIN_NAME);
  const borrowed = (vuePlugin?.api as VuePluginApi | undefined)?.options.compiler;
  if (borrowed) return borrowed;
  // Same lookup order as plugin-vue, so a project without it still gets the compiler its Vue ships.
  for (const id of ['vue/compiler-sfc', '@vue/compiler-sfc']) {
    try {
      return require(require.resolve(id, {paths: [root]})) as VueCompiler;
    } catch {
      continue;
    }
  }
  throw new Error('multifront: could not find @vue/compiler-sfc. Install vue or @vue/compiler-sfc in your project.');
}
