import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {SourceMapInput} from '@jridgewell/trace-mapping';
import type {Plugin, ResolvedConfig, Rolldown} from 'vite';
import {splitId, virtualTarget} from './ids.ts';

// plugin-svelte's marker plugin, there for other plugins to detect it.
const SVELTE_PLUGIN_NAME = 'vite-plugin-svelte';
const COMPILE_PLUGIN_NAME = 'vite-plugin-svelte:compile';
const HOT_UPDATE_PLUGIN_NAME = 'vite-plugin-svelte:hot-update';

export const SVELTE_PLUGIN_MISSING = 'the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins';

const SVELTE_ID = /\.ucf\.svelte\.svelte$/;

// Every compiled component imports Svelte's runtime; Vite's import analysis runs only after our post plugins.
const COMPILED = /\bfrom\s*["']svelte\/internal\/(?:client|server)["']/;

const wrappedHandlers = new WeakSet<object>();

export function hasSveltePlugin(plugins: readonly Plugin[]): boolean {
  return plugins.some((plugin) => plugin.name === SVELTE_PLUGIN_NAME);
}

function withMember<Target extends object>(target: Target, key: keyof Target, value: unknown): Target {
  return new Proxy(target, {
    get(object, name) {
      if (name === key) return value;
      const member: unknown = Reflect.get(object, name, object);
      return typeof member === 'function' ? member.bind(object) : member;
    },
  });
}

// plugin-svelte prefixes its message with the compiled file's name (may hold spaces) and position.
const GENERATED_PREFIX = /^.*?\.ucf\.svelte\.svelte(?::\d+:\d+)? /;

/** A Svelte compiler error at its place in the `.ucf` file: an agent cannot open the compiled `Card.ucf.svelte.svelte`. */
function compileErrorInUcf(
  context: Rolldown.TransformPluginContext,
  id: string,
  err: Rolldown.RollupError
): Rolldown.RollupError {
  const file = virtualTarget(splitId(id).path)!.file;
  const message = String(err.message ?? err)
    .split('\n')[0]!
    .replace(GENERATED_PREFIX, '');
  const at = err.loc;
  const original = at && originalPositionFor(new TraceMap(context.getCombinedSourcemap() as SourceMapInput), at);
  const loc = original && original.line !== null ? {file, line: original.line, column: original.column} : undefined;
  return {message, ...(loc && {loc}), meta: {message}, cause: err};
}

/** plugin-svelte merges our `load` map via `getCombinedSourcemap()`, then Vite applies it again: every mapping lost. */
function wrapCompile(config: ResolvedConfig): void {
  const transform = config.plugins.find((plugin) => plugin.name === COMPILE_PLUGIN_NAME)?.transform;
  // A restart runs `configResolved` again on the same plugin-svelte instance.
  if (!transform || typeof transform === 'function' || wrappedHandlers.has(transform.handler)) return;
  const handler = transform.handler;
  transform.handler = async function (code, id, ...rest) {
    if (!SVELTE_ID.test(id)) return handler.call(this, code, id, ...rest);
    const context = withMember(this, 'getCombinedSourcemap', () => null);
    try {
      return await handler.call(context, code, id, ...rest);
    } catch (err) {
      // Vite's dev server maps positions back itself; a `loc` would get mapped twice.
      if (this.environment.mode === 'dev') throw err;
      return this.error(compileErrorInUcf(this, id, err as Rolldown.RollupError));
    }
  };
  wrappedHandlers.add(transform.handler);
}

/** plugin-svelte's hot update first transforms the changed file: a `.ucf` file's bare Vue id, which throws without plugin-vue. */
function wrapHotUpdate(config: ResolvedConfig): void {
  const hotUpdate = config.plugins.find((plugin) => plugin.name === HOT_UPDATE_PLUGIN_NAME)?.hotUpdate;
  if (!hotUpdate || typeof hotUpdate === 'function' || wrappedHandlers.has(hotUpdate.handler)) return;
  const handler = hotUpdate.handler;
  hotUpdate.handler = function (options) {
    if (!options.file.endsWith('.ucf')) return handler.call(this, options);
    const {environment} = this;
    // That request only refreshes plugin-svelte's CSS cache, and our Svelte ids emit no Svelte CSS.
    const transformRequest = (url: string) => (url === options.file ? Promise.resolve(null) : environment.transformRequest(url));
    return handler.call(withMember(this, 'environment', withMember(environment, 'transformRequest', transformRequest)), options);
  };
  wrappedHandlers.add(hotUpdate.handler);
}

export function composeSveltePlugin(config: ResolvedConfig): void {
  wrapCompile(config);
  wrapHotUpdate(config);
}

/** Before the attribute rewrite: our id left uncompiled would hand raw markup to Rolldown. */
export function svelteCompiledPlugin(hasPlugin: () => boolean): Plugin {
  return {
    name: 'multifront:svelte-compiled',
    enforce: 'post',
    transform: {
      filter: {id: SVELTE_ID},
      handler(code, id) {
        if (COMPILED.test(code)) return;
        // A dev URL of the id skips the import's plugin check.
        if (!hasPlugin()) this.error(`${id}: ${SVELTE_PLUGIN_MISSING}`);
        this.error(
          `${id}: @sveltejs/vite-plugin-svelte did not compile this module; its include and exclude options must let ids ending in .ucf.svelte.svelte through`
        );
      },
    },
  };
}
