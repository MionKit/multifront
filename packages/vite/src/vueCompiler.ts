import type {Plugin} from 'vite';
import {loadVueCompiler} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';

const VUE_PLUGIN_NAME = 'vite:vue';

interface VuePluginApi {
  options: {compiler?: VueCompiler | null; root: string};
}

export function hasVuePlugin(plugins: readonly Plugin[]): boolean {
  return plugins.some((plugin) => plugin.name === VUE_PLUGIN_NAME);
}

/** plugin-vue only resolves its compiler in `buildStart`, so call this from a later hook. */
export function getVueCompiler(plugins: readonly Plugin[], root: string): VueCompiler {
  const vuePlugin = plugins.find((plugin) => plugin.name === VUE_PLUGIN_NAME);
  const borrowed = (vuePlugin?.api as VuePluginApi | undefined)?.options.compiler;
  return borrowed ?? loadVueCompiler(root);
}
