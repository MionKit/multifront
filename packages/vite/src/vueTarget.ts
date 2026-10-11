import {resolve} from 'node:path';
import {vueSfcCode} from '@multifront/core';
import type {SplitResult, VueCompiler} from '@multifront/core';
import type {Options} from '@vitejs/plugin-vue';
import {normalizePath} from 'vite';
import type {ResolvedConfig, Rolldown} from 'vite';
import {composeCssModules} from './cssModules.ts';
import type {VuePluginApi} from './types.ts';
import {VUE_PLUGIN_NAME} from './vueCompiler.ts';

type ComponentIdGenerator = NonNullable<Options['features']>['componentIdGenerator'];
type IdFunction = Extract<ComponentIdGenerator, Function>;

/** The Vue target's id is the bare `.ucf` path (spec 4.3). */
export const VUE_INCLUDE = /\.ucf$/;

// plugin-vue's transform tests only the path, so its hook filter must drop our style and class map ids.
const UCF_SUB_REQUEST = /\.ucf\?(?:.*&)?ucf\b/;

export const VUE_PLUGIN_MISSING = 'the vue target needs @vitejs/plugin-vue in your Vite plugins';

const EMPTY_SCAN: Rolldown.SourceDescription = {code: 'export default {}', moduleType: 'js'};

function addPattern(api: VuePluginApi, key: 'include' | 'exclude', pattern: RegExp): void {
  const list = [api[key] ?? []].flat();
  // A second `configResolved` (a restart with the same plugins) comes after `options`, when the setter throws.
  if (!list.includes(pattern)) api[key] = [...list, pattern];
}

function componentIdGenerator(user: ComponentIdGenerator, root: string, scopeIdOf: (file: string) => string): IdFunction {
  return (path, source, production, getHash) => {
    // The id hashes the raw `.ucf` source, never the SFC code plugin-vue passes.
    if (VUE_INCLUDE.test(path)) return scopeIdOf(normalizePath(resolve(root, path)));
    if (typeof user === 'function') return user(path, source, production, getHash);
    if (user === 'filepath') return getHash(path);
    if (user === 'filepath-source') return getHash(path + source);
    return getHash(path + (production ? source : ''));
  };
}

/** Call from `configResolved`: it runs before plugin-vue's `options` hook, the last moment its setters allow. */
export function composeVuePlugin(config: ResolvedConfig, scopeIdOf: (file: string) => string): void {
  const api = config.plugins.find((plugin) => plugin.name === VUE_PLUGIN_NAME)?.api as VuePluginApi | undefined;
  if (!api) return;
  addPattern(api, 'include', VUE_INCLUDE);
  addPattern(api, 'exclude', UCF_SUB_REQUEST);
  const features = api.options.features;
  const generator = componentIdGenerator(features?.componentIdGenerator, config.root, scopeIdOf);
  api.options = {...api.options, features: {...features, componentIdGenerator: generator}};
  composeCssModules(config, scopeIdOf);
}

/** The `<vue>` block as the dependency scan reads it; errors are left to the real pipeline. */
export function vueScanScript(split: SplitResult, compiler: VueCompiler): Rolldown.SourceDescription {
  const {code} = vueSfcCode(split.source, split.blocks, split.filename);
  const {descriptor, errors} = compiler.parse(code, {filename: split.filename});
  const script = descriptor.scriptSetup ?? descriptor.script;
  if (errors.length > 0 || !script) return EMPTY_SCAN;
  const lang = script.lang ?? 'js';
  try {
    // Compiled, not the raw script: TypeScript stripping would drop an import only the template uses.
    const compiled = compiler.compileScript(descriptor, {id: split.filename});
    return {code: compiled.content, moduleType: ['jsx', 'ts', 'tsx'].includes(lang) ? lang : 'js'};
  } catch {
    return EMPTY_SCAN;
  }
}
