import {join} from 'node:path';
import {createTypeScriptPlugin} from '@multifront/language-tools/typescript-plugin';
import type * as ts from 'typescript';
import {HOST_TYPESCRIPT} from './bundle/hostTypeScript.ts';

// Bundled, language-core's and svelte2tsx's own type folders are gone: `pnpm devx vsix` copies them beside the bundle.
const plugin = createTypeScriptPlugin({
  vueTypesRoot: join(import.meta.dirname, 'vue-types'),
  svelteTypesRoot: join(import.meta.dirname, 'svelte-types'),
});

// Bundled to `module.exports = <factory>`: tsserver skips a module that is not a function.
export default ((modules) => {
  // What svelte2tsx's `typescript` import becomes in the bundle.
  (globalThis as {[HOST_TYPESCRIPT]?: unknown})[HOST_TYPESCRIPT] = modules.typescript;
  return plugin(modules);
}) satisfies ts.server.PluginModuleFactory;
