import {resolve} from 'node:path';
import {vueSfcCode} from '@multifront/core';
import type {SplitResult, VueCompiler} from '@multifront/core';
import type {Options} from '@vitejs/plugin-vue';
import {normalizePath} from 'vite';
import type {Plugin, ResolvedConfig, Rolldown} from 'vite';
import {composeCssModules} from './cssModules.ts';
import {VUE_INCLUDE} from './ids.ts';
import type {VuePluginApi} from './types.ts';
import {VUE_PLUGIN_NAME, wrappedCompilers} from './vueCompiler.ts';

type ComponentIdGenerator = NonNullable<Options['features']>['componentIdGenerator'];
type IdFunction = Extract<ComponentIdGenerator, Function>;
type FullCompiler = NonNullable<Options['compiler']>;
type SfcMap = ReturnType<FullCompiler['compileScript']>['map'];
type SourceBehind = (file: string, code: string) => string | undefined;

// plugin-vue's transform tests only the path, so its hook filter must drop our style and class map ids.
const UCF_SUB_REQUEST = /\.ucf\?(?:.*&)?ucf\b/;

export const VUE_PLUGIN_MISSING = 'the vue target needs @vitejs/plugin-vue in your Vite plugins';

const EMPTY_SCAN: Rolldown.SourceDescription = {code: 'export default {}', moduleType: 'js'};

// Module level, as plugin-vue's descriptor cache is.
const handedSources = new Map<string, string>();

/** Our transform handed plugin-vue the SFC code of `source`. */
export function handedToVue(file: string, source: string): void {
  handedSources.set(file, source);
}

// The sub-requests of one file arrive together on a cold cache: they share one warm-up.
const warmingUp = new Map<string, Promise<unknown>>();

/** Before plugin-vue loads a `.ucf?vue&…` sub-request: on a cache miss it would parse the raw file from disk. */
export async function warmUpVue(context: Rolldown.PluginContext, file: string, source: string): Promise<void> {
  if (handedSources.get(file) === source) return;
  let pending = warmingUp.get(file);
  if (!pending) {
    // Runs our transform and plugin-vue's main one, which fills its cache.
    pending = context.load({id: file}).finally(() => warmingUp.delete(file));
    warmingUp.set(file, pending);
  }
  await pending;
}

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

function withSource(map: SfcMap, file: string | undefined, code: string, sourceBehind: SourceBehind): void {
  // compiler-sfc's parse cache hands back a descriptor already patched.
  if (!map || !file || !VUE_INCLUDE.test(file) || Object.getOwnPropertyDescriptor(map, 'sourcesContent')?.get) return;
  const parsed = map.sourcesContent;
  // Read on use: plugin-vue keeps its compiled script while a `<react>`-only edit leaves the SFC code the same.
  Object.defineProperty(map, 'sourcesContent', {
    configurable: true,
    enumerable: true,
    get: () => {
      const source = sourceBehind(file, code);
      return source === undefined ? parsed : map.sources.map(() => source);
    },
  });
}

/** After plugin-vue's `buildStart`: its sub-request maps hold the blanked SFC code; devtools need the `.ucf`. */
export function wrapVueCompiler(plugins: readonly Plugin[], sourceBehind: SourceBehind): void {
  const api = plugins.find((plugin) => plugin.name === VUE_PLUGIN_NAME)?.api as VuePluginApi | undefined;
  const compiler = api?.options.compiler;
  // A restart runs `buildStart` again on the same plugin-vue instance.
  if (!api || !compiler || wrappedCompilers.has(compiler)) return;
  const wrapper: FullCompiler = {
    ...compiler,
    parse(code, options) {
      const result = compiler.parse(code, options);
      const {template, script, scriptSetup, styles, customBlocks} = result.descriptor;
      for (const block of [template, script, scriptSetup, ...styles, ...customBlocks]) {
        withSource(block?.map, options?.filename, code, sourceBehind);
      }
      return result;
    },
    compileScript(descriptor, options) {
      const result = compiler.compileScript(descriptor, options);
      withSource(result.map, descriptor.filename, descriptor.source, sourceBehind);
      return result;
    },
  };
  wrappedCompilers.set(wrapper, compiler);
  api.options = {...api.options, compiler: wrapper};
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
