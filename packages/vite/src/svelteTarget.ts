import type {Plugin, ResolvedConfig} from 'vite';

// plugin-svelte's marker plugin, there for other plugins to detect it.
export const SVELTE_PLUGIN_NAME = 'vite-plugin-svelte';
const COMPILE_PLUGIN_NAME = 'vite-plugin-svelte:compile';

export const SVELTE_PLUGIN_MISSING = 'the svelte framework needs @sveltejs/vite-plugin-svelte in your Vite plugins';

const SVELTE_ID = /\.ucf\.svelte\.svelte$/;

// Every compiled component imports Svelte's runtime; Vite's import analysis runs only after our post plugins.
const COMPILED = /\bfrom\s*["']svelte\/internal\/(?:client|server)["']/;

type TransformHandler = Extract<NonNullable<Plugin['transform']>, {handler: unknown}>['handler'];

const wrappedHandlers = new WeakSet<TransformHandler>();

export function hasSveltePlugin(plugins: readonly Plugin[]): boolean {
  return plugins.some((plugin) => plugin.name === SVELTE_PLUGIN_NAME);
}

/**
 * plugin-svelte hands `getCombinedSourcemap()` to the compiler, which merges our `load` map into its own; Vite then
 * applies our map a second time and every mapping is lost. For our ids its compile sees no previous map.
 */
export function composeSveltePlugin(config: ResolvedConfig): void {
  const transform = config.plugins.find((plugin) => plugin.name === COMPILE_PLUGIN_NAME)?.transform;
  // A restart runs `configResolved` again on the same plugin-svelte instance.
  if (!transform || typeof transform === 'function' || wrappedHandlers.has(transform.handler)) return;
  const handler = transform.handler;
  const wrapper: TransformHandler = function (code, id, ...rest) {
    if (!SVELTE_ID.test(id)) return handler.call(this, code, id, ...rest);
    const context = new Proxy(this, {
      get(target, key) {
        if (key === 'getCombinedSourcemap') return () => null;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return handler.call(context, code, id, ...rest);
  };
  wrappedHandlers.add(wrapper);
  transform.handler = wrapper;
}

/** Before the attribute rewrite: a user `exclude` matching our id would hand raw markup to Rolldown. */
export function svelteCompiledPlugin(): Plugin {
  return {
    name: 'multifront:svelte-compiled',
    enforce: 'post',
    transform: {
      filter: {id: SVELTE_ID},
      handler(code, id) {
        if (COMPILED.test(code)) return;
        this.error(
          `${id}: @sveltejs/vite-plugin-svelte did not compile this module; its include and exclude options must let ids ending in .ucf.svelte.svelte through`
        );
      },
    },
  };
}
