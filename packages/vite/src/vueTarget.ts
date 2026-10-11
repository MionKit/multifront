import {resolve} from 'node:path';
import {vueSfcCode} from '@multifront/core';
import type {SplitResult, VueCompiler} from '@multifront/core';
import type {Options} from '@vitejs/plugin-vue';
import {normalizePath} from 'vite';
import type {Plugin, ResolvedConfig, Rolldown} from 'vite';
import {composeCssModules} from './cssModules.ts';
import {VUE_INCLUDE} from './ids.ts';
import {sameBlock} from './hmr.ts';
import type {UcfCache, VuePluginApi} from './types.ts';
import {vuePluginApi, wrappedCompilers} from './vueCompiler.ts';

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
const handedVersions = new Map<string, {source: string; sfc: string}>();

/** plugin-vue's descriptor cache holds `sfc`, the SFC code of `source`. */
export function handedToVue(file: string, source: string, sfc: string): void {
  handedVersions.set(file, {source, sfc});
}

// The sub-requests of one file arrive together on a cold cache: they share one warm-up.
const warmingUp = new Map<string, Promise<unknown>>();

/** Before plugin-vue loads a `.ucf?vue&…` sub-request: on a cache miss it would parse the raw file from disk. */
export async function warmUpVue(context: Rolldown.PluginContext, file: string, source: string): Promise<void> {
  if (handedVersions.get(file)?.source === source) return;
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
  const api = vuePluginApi(config.plugins);
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
  const api = vuePluginApi(plugins);
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

type Descriptor = ReturnType<VueCompiler['parse']>['descriptor'];
type VueOptions = VuePluginApi['options'];

const RERENDER_EXPORT = 'export const _rerender_only';

function sameBlocks(left: Descriptor['customBlocks'], right: Descriptor['customBlocks']): boolean {
  return left.length === right.length && left.every((block, index) => sameBlock(block, right[index]));
}

// Dev setup returns only the imports its template uses (TypeScript): a template starting to use one needs the script.
function needsScript(compiler: VueCompiler, options: VueOptions, before: Descriptor, after: Descriptor): boolean {
  if (!before.script && !before.scriptSetup) return false;
  const {script, features} = options;
  try {
    // plugin-vue's own script options: a type only `globalTypeFiles` resolves would throw without them.
    const propsDestructure = features?.propsDestructure ?? script?.propsDestructure;
    const {imports} = compiler.compileScript(before, {...script, id: before.filename, propsDestructure});
    return imports !== undefined && after.shouldForceReload(imports);
  } catch {
    return true;
  }
}

/** What plugin-vue makes of a hot update: a re-render only, and whether it stores the new descriptor. */
function hotChange(compiler: VueCompiler, options: VueOptions, file: string, before: string, after: string) {
  // Parse errors kept, as plugin-vue's hot update does: fixing a template typo still re-renders.
  const {descriptor: old} = compiler.parse(before, {filename: file});
  const {descriptor: now} = compiler.parse(after, {filename: file});
  const template = !sameBlock(old.template, now.template);
  const style = now.styles.some((block, index) => !sameBlock(old.styles[index], block));
  const rerenderOnly =
    template &&
    !!now.template &&
    sameBlock(old.script, now.script) &&
    sameBlock(old.scriptSetup, now.scriptSetup) &&
    sameBlocks(old.styles, now.styles) &&
    sameBlocks(old.customBlocks, now.customBlocks) &&
    !needsScript(compiler, options, old, now);
  // plugin-vue's `handleHotUpdate` stores the new descriptor only for a template or style update.
  return {rerenderOnly, stored: template || style};
}

/** Its own plugin: Vite calls `handleHotUpdate` only on plugins without `hotUpdate`, with a context of its own. */
export function vueHmrPlugin(cache: UcfCache, vueOf: () => {compiler: VueCompiler; options: VueOptions} | undefined): Plugin {
  const rerenderOnly = new Set<string>();
  return {
    name: 'multifront:vue-hmr',
    enforce: 'pre',
    async handleHotUpdate(ctx) {
      const {file} = ctx;
      const vue = vueOf();
      const before = handedVersions.get(file)?.sfc;
      // Never handed: plugin-vue holds no descriptor of the file and skips it.
      if (!vue || !VUE_INCLUDE.test(file) || before === undefined) return;
      const version = cache.updateUcf(file, await ctx.read());
      const sfc = vueSfcCode(version.source, version.split.blocks, file).code;
      version.sfc = sfc;
      // plugin-vue's hook runs next on this same context (and so does every later `handleHotUpdate`).
      ctx.read = () => sfc;
      const change = hotChange(vue.compiler, vue.options, file, before, sfc);
      if (change.rerenderOnly) rerenderOnly.add(file);
      else rerenderOnly.delete(file);
      // Else its cache keeps the old positions: the next sub-request must warm it up.
      if (change.stored) handedToVue(file, version.source, sfc);
    },
    transform: {
      // After plugin-vue's; only its dev client main module carries the HMR runtime.
      order: 'post',
      filter: {id: VUE_INCLUDE, code: '__VUE_HMR_RUNTIME__'},
      handler(code, id) {
        // A plugin-vue that writes the line itself would make ours a duplicate export.
        if (!rerenderOnly.has(id) || code.includes(RERENDER_EXPORT)) return undefined;
        // plugin-vue writes this line for `.vue` files only: it keeps a previous descriptor of no other file.
        const line = `${RERENDER_EXPORT} = __VUE_HMR_RUNTIME__.CHANGED_FILE === ${JSON.stringify(id)}`;
        return {code: `${code}\n${line}`, map: null};
      },
    },
  };
}
