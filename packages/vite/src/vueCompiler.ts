import type {Plugin} from 'vite';
import {loadVueCompiler} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';
import type {VuePluginApi} from './types.ts';

export const VUE_PLUGIN_NAME = 'vite:vue';

/** Each `wrapVueCompiler()` wrapper → the compiler plugin-vue resolved. */
export const wrappedCompilers = new WeakMap<VueCompiler, VueCompiler>();

export function hasVuePlugin(plugins: readonly Plugin[]): boolean {
  return plugins.some((plugin) => plugin.name === VUE_PLUGIN_NAME);
}

export function vuePluginApi(plugins: readonly Plugin[]): VuePluginApi | undefined {
  return plugins.find((plugin) => plugin.name === VUE_PLUGIN_NAME)?.api as VuePluginApi | undefined;
}

/** plugin-vue only resolves its compiler in `buildStart`, so call this from a later hook. */
export function getVueCompiler(plugins: readonly Plugin[], root: string): VueCompiler {
  const borrowed = vuePluginApi(plugins)?.options.compiler;
  return (borrowed && wrappedCompilers.get(borrowed)) ?? borrowed ?? loadVueCompiler(root);
}
