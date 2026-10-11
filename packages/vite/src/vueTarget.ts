import {vueSfcCode} from '@multifront/core';
import type {SplitResult, VueCompiler} from '@multifront/core';
import type {Plugin} from 'vite';
import type {VuePluginApi} from './types.ts';
import {VUE_PLUGIN_NAME} from './vueCompiler.ts';

/** The Vue target's id is the bare `.ucf` path (spec 4.3). */
export const VUE_INCLUDE = /\.ucf$/;

// plugin-vue's transform tests only the path, so its hook filter must drop our style and class map ids.
export const UCF_SUB_REQUEST = /\.ucf\?(?:.*&)?ucf\b/;

export const VUE_PLUGIN_MISSING = 'the vue target needs @vitejs/plugin-vue in your Vite plugins';

type ScanModuleType = 'js' | 'jsx' | 'ts' | 'tsx';

const EMPTY_SCAN = {code: 'export default {}', moduleType: 'js' as ScanModuleType};

function withPattern(patterns: VuePluginApi['include'], pattern: RegExp): VuePluginApi['include'] {
  const list = patterns === undefined ? [] : Array.isArray(patterns) ? patterns : [patterns];
  // A second `configResolved` (a restart with the same plugins) comes after `options`, when the setter throws.
  return list.includes(pattern) ? undefined : [...list, pattern];
}

/** Call from `configResolved`: it runs before plugin-vue's `options` hook, the last moment its setters allow. */
export function composeVuePlugin(plugins: readonly Plugin[]): void {
  for (const plugin of plugins) {
    if (plugin.name !== VUE_PLUGIN_NAME) continue;
    const api = plugin.api as VuePluginApi;
    const include = withPattern(api.include, VUE_INCLUDE);
    if (include) api.include = include;
    const exclude = withPattern(api.exclude, UCF_SUB_REQUEST);
    if (exclude) api.exclude = exclude;
  }
}

/** The `<vue>` block as the dependency scan reads it; errors are left to the real pipeline. */
export function vueScanScript(split: SplitResult, compiler: VueCompiler): {code: string; moduleType: ScanModuleType} {
  if (split.errors.length > 0) return EMPTY_SCAN;
  const {code} = vueSfcCode(split.source, split.blocks, split.filename);
  const {descriptor, errors} = compiler.parse(code, {filename: split.filename});
  const script = descriptor.scriptSetup ?? descriptor.script;
  if (errors.length > 0 || !script) return EMPTY_SCAN;
  const lang = script.lang ?? 'js';
  try {
    // Compiled, not the raw script: TypeScript stripping would drop an import only the template uses.
    const compiled = compiler.compileScript(descriptor, {id: split.filename});
    return {code: compiled.content, moduleType: ['jsx', 'ts', 'tsx'].includes(lang) ? (lang as ScanModuleType) : 'js'};
  } catch {
    return EMPTY_SCAN;
  }
}
