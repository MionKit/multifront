import {isFileLoadingAllowed, normalizePath} from 'vite';
import type {Plugin, ResolvedConfig, Rolldown} from 'vite';
import {
  DiagnosticsError,
  SCOPE_HELPER_ID,
  TARGETS,
  buildTarget,
  getBlockKind,
  importerFromId,
  loadSvelteCompiler,
  missingTargetBlockMessage,
  needsUseClient,
  resolveTarget,
  rewriteImportAttributes,
  rootRelativePath,
  scopeHelperCode,
  scopeId,
} from '@multifront/core';
import type {Target, VueCompiler} from '@multifront/core';
import {createUcfCache} from './cache.ts';
import {ucfHotUpdate} from './hmr.ts';
import {JS_LIKE, TARGET_SUFFIX, VUE_INCLUDE, splitId, virtualTarget} from './ids.ts';
import {attributesPlugin, importersPlugin} from './attributes.ts';
import {describeDiagnostic, importErrorMessage, rollupError} from './diagnostics.ts';
import type {MultifrontOptions, UcfEntry, UcfModuleMeta} from './types.ts';
import {getVueCompiler, hasVuePlugin, vuePluginApi} from './vueCompiler.ts';
import {SVELTE_PLUGIN_MISSING, composeSveltePlugin, hasSveltePlugin, svelteCompiledPlugin} from './svelteTarget.ts';
import {
  VUE_PLUGIN_MISSING,
  composeVuePlugin,
  handedToVue,
  vueHmrPlugin,
  vueScanScript,
  warmUpVue,
  wrapVueCompiler,
} from './vueTarget.ts';

const REACT_ID = /\.ucf\.react\.tsx$/;
// Vue target's scan id: `.ts` makes it scannable; `importerFromId` maps its imports to the `<vue>` block.
const VUE_SCAN_SUFFIX = '.vue.ts';
const VUE_SCAN_ID = /\.ucf\.vue\.ts$/;
// Scan id of an HTML file's inline `<script>`.
const SCAN_SCRIPT = /\.html\?id=\d+$/;
// Unescaped, as the helper id holds no regex metacharacter.
const SCOPE_HELPER = new RegExp(`^\\0?${SCOPE_HELPER_ID}$`);

function built(context: Rolldown.PluginContext, {split, ctx}: UcfEntry, target: Target) {
  try {
    const {code, map} = buildTarget(split, ctx, target);
    return {code, map};
  } catch (err) {
    if (err instanceof DiagnosticsError) context.error(rollupError(err.diagnostics));
    throw err;
  }
}

function isUrlImporter(importer: string | undefined, root: string): boolean {
  return importer === undefined || normalizePath(importer) === `${root}/index.html`;
}

export function multifront(options: MultifrontOptions = {}): Plugin[] {
  const frameworks = options.frameworks ?? [...TARGETS];
  if (options.framework && !frameworks.includes(options.framework)) {
    throw new Error(
      `multifront: framework '${options.framework}' is not one of the enabled frameworks (${frameworks.join(', ')}).`
    );
  }
  let config: ResolvedConfig | undefined;
  let vueCompiler: VueCompiler | undefined;
  const api = {
    get vueCompiler(): VueCompiler {
      if (!config) throw new Error('multifront: the Vue compiler is only available after Vite resolved its config.');
      vueCompiler ??= getVueCompiler(config.plugins, config.root);
      return vueCompiler;
    },
  };
  const cache = createUcfCache(() => ({root: config!.root, compiler: api.vueCompiler, production: config!.isProduction}));
  // Equals `ctx.scopeId`, computed synchronously for plugin-vue.
  const ucfScopeId = (file: string) => scopeId(rootRelativePath(config!.root, file), cache.sourceOf(file), config!.isProduction);

  // Vite's scanner reads every module from disk unless a plugin loads it: these run before its own (spike 3, check 2).
  const scanPlugin: Rolldown.Plugin = {
    name: 'multifront:scan',
    load: {
      filter: {id: [REACT_ID, VUE_SCAN_ID]},
      async handler(id) {
        if (VUE_SCAN_ID.test(id)) {
          const file = id.slice(0, -VUE_SCAN_SUFFIX.length);
          // Not `api.vueCompiler`: the scan may run before plugin-vue lends its compiler to the build.
          return vueScanScript(await cache.splitUcf(file), getVueCompiler(config!.plugins, config!.root));
        }
        const split = await cache.splitUcf(id.slice(0, -TARGET_SUFFIX.react.length));
        return {code: split.targets.react?.content ?? '', moduleType: 'tsx'};
      },
    },
    // Rolldown passes `resolveId` no import attributes: the scan must read `?framework=` from the specifier.
    transform: {
      filter: {id: [JS_LIKE, SCAN_SCRIPT], code: /\.ucf/},
      handler(code, id, {moduleType}) {
        // A script the scan cut out of `C.vue` or `index.html` names its language only in its module type.
        const lang = `${id.includes('?') ? '&' : '?'}lang.${moduleType}`;
        // Errors are left to the real pipeline, which can point at the import.
        const {code: rewritten, map} = rewriteImportAttributes(code, id + lang);
        return map ? rewritten : undefined;
      },
    },
  };

  const pre: Plugin = {
    name: 'multifront',
    // Before plugin-vue, plugin-react and plugin-svelte, so they only ever see plain component files.
    enforce: 'pre',
    config: () => ({optimizeDeps: {rolldownOptions: {plugins: [scanPlugin]}}}),
    configResolved(resolved) {
      config = resolved;
      composeVuePlugin(resolved, ucfScopeId);
      composeSveltePlugin(resolved);
    },
    buildStart: {
      order: 'post',
      handler() {
        wrapVueCompiler(config!.plugins, cache.sourceBehind);
      },
    },
    buildEnd() {
      vueCompiler = undefined;
    },
    // After plugin-vue's `handleHotUpdate`, which hands on only its own modules of a file also imported as another target.
    hotUpdate: {order: 'post', handler: ucfHotUpdate(cache, () => hasVuePlugin(config!.plugins))},
    resolveId: {
      filter: {id: [/\.ucf/, SCOPE_HELPER]},
      async handler(id, importer, resolveOptions) {
        if (id === SCOPE_HELPER_ID) return `\0${SCOPE_HELPER_ID}`;
        const {path, query} = splitId(id);
        const own = virtualTarget(path);
        if (own) {
          // A dev URL (`/src/Card.ucf.react.tsx`) or an id seen again.
          const resolved = await this.resolve(own.file, importer, {skipSelf: true});
          return resolved && !resolved.external ? resolved.id + TARGET_SUFFIX[own.target] : null;
        }
        // Our style and class map ids, `?raw` and the like: Vite resolves the path and keeps the query.
        if (!path.endsWith('.ucf') || [...query.keys()].some((key) => key !== 'framework')) return undefined;
        // Vite's dependency scanner sets it; the public type leaves it out.
        const {scan} = resolveOptions as {scan?: boolean};
        const resolved = await this.resolve(path, importer, {...resolveOptions, skipSelf: true});
        if (!resolved || resolved.external) return resolved;
        const file = splitId(resolved.id).path;
        // Dev URL of the Vue id (the real path): Vite resolves URLs with no importer or with its root `index.html`.
        if (config!.command === 'serve' && !query.has('framework') && isUrlImporter(importer, config!.root)) return file;
        const from = importer === undefined ? undefined : importerFromId(importer);
        // In dev Vite resolves the file `load` watches from the module itself: the real file, not an import.
        if (from?.block && from.fileName === file && !query.has('framework')) return file;
        const choice = resolveTarget(from, query.get('framework') ?? undefined, options);
        const vuePlugin = hasVuePlugin(config!.plugins);
        // The scan skips what it cannot follow; the real pipeline reports it.
        const unscanned = 'error' in choice || choice.target === 'svelte' || (choice.target === 'vue' && !vuePlugin);
        if (scan && unscanned) return {id: file, external: true};
        if ('error' in choice) this.error(importErrorMessage(path, from?.fileName, describeDiagnostic(choice.error)));
        const {target} = choice;
        if (!(await cache.splitUcf(file)).targets[target]) {
          if (scan) return {id: file, external: true};
          const message = from ? missingTargetBlockMessage(from.fileName, file, target) : `${file} has no <${target}> block`;
          this.error(describeDiagnostic({code: 'missing-target-block', message}));
        }
        if (target === 'vue' && !vuePlugin) this.error(importErrorMessage(path, from?.fileName, VUE_PLUGIN_MISSING));
        if (target === 'svelte' && !hasSveltePlugin(config!.plugins)) {
          const message = `${SVELTE_PLUGIN_MISSING} (it compiles ${file + TARGET_SUFFIX.svelte})`;
          this.error(importErrorMessage(path, from?.fileName, message));
        }
        return file + (scan && target === 'vue' ? VUE_SCAN_SUFFIX : TARGET_SUFFIX[target]);
      },
    },
    load: {
      filter: {id: [/\.ucf/, SCOPE_HELPER]},
      async handler(id) {
        // Dev exports the fragment warning too, as `react.build` calls it only in dev.
        if (id === `\0${SCOPE_HELPER_ID}`) return scopeHelperCode(!config!.isProduction);
        const {path, query} = splitId(id);
        const file = virtualTarget(path)?.file ?? path;
        // We read the file ourselves, so Vite's `server.fs.allow` check would never run; Vite skips it in SSR too.
        const browser = config!.command === 'serve' && this.environment.config.consumer === 'client';
        if (browser && file.endsWith('.ucf') && !isFileLoadingAllowed(config!, file)) {
          // Vite's transform middleware answers this code with the 403 page it gives the file itself.
          throw Object.assign(new Error(`Denied ID ${file}`), {code: 'ERR_DENIED_ID', id: file});
        }
        if (query.has('vue')) {
          // A fresh process or a restart: plugin-vue's cache may lack this content.
          if (path.endsWith('.ucf')) await warmUpVue(this, path, (await cache.splitUcf(path)).source);
          return undefined;
        }
        if (query.has('ucf')) {
          if (query.get('type') !== 'style') return undefined;
          const index = Number(query.get('index'));
          const {split, ctx} = await cache.loadUcf(path);
          const style = ctx.styles[index];
          const block = split.styles[index];
          if (!style || !block) return undefined;
          if (query.has('module')) return `export default ${JSON.stringify(style.classes ?? {})};`;
          const errors = [...getBlockKind('style').check(block, split), ...style.errors];
          if (errors.length > 0) this.error(rollupError(errors));
          return {code: style.code, map: style.map};
        }
        const own =
          virtualTarget(path) ?? (path.endsWith('.ucf') && query.size === 0 ? {target: 'vue' as const, file: path} : undefined);
        if (!own) return undefined;
        // Vite watches no file behind an id a plugin loads; the react and svelte ids name none (spec 4.3).
        this.addWatchFile(own.file);
        // The raw source: our transform turns it into SFC code.
        if (own.target === 'vue') return (await cache.splitUcf(own.file)).source;
        const entry = await cache.loadUcf(own.file);
        const result = built(this, entry, own.target);
        // Only a library build reads it, to put `"use client"` atop the output file: the dev server skips the parse.
        if (own.target !== 'react' || config!.command !== 'build') return result;
        const meta: UcfModuleMeta = {useClient: needsUseClient(entry.split.targets.react!.content, own.file)};
        return {...result, meta: {multifront: meta}};
      },
    },
    transform: {
      filter: {id: VUE_INCLUDE},
      async handler(code, id) {
        if (!hasVuePlugin(config!.plugins)) this.error(`${id}: ${VUE_PLUGIN_MISSING}`);
        const version = cache.updateUcf(id, code);
        const sfc = built(this, await cache.contextOf(version), 'vue');
        version.sfc = sfc.code;
        handedToVue(id, version.source, sfc.code);
        return sfc;
      },
    },
    api,
  };
  const vueOf = () => {
    const vueApi = vuePluginApi(config!.plugins);
    return vueApi && {compiler: api.vueCompiler, options: vueApi.options};
  };
  const importers = importersPlugin(options, {
    vue: () => (hasVuePlugin(config!.plugins) ? api.vueCompiler : undefined),
    svelte: () => loadSvelteCompiler(config!.root),
  });
  return [
    pre,
    vueHmrPlugin(cache, vueOf),
    importers,
    svelteCompiledPlugin(() => hasSveltePlugin(config!.plugins)),
    attributesPlugin(options),
  ];
}
