import type {Plugin, ResolvedConfig} from 'vite';
import {TARGETS} from '@multifront/core';
import type {MultifrontOptions, VueCompiler} from './types.ts';
import {getVueCompiler} from './vueCompiler.ts';

export type {MultifrontOptions, VueCompiler} from './types.ts';
export {getVueCompiler} from './vueCompiler.ts';

export function multifront(options: MultifrontOptions = {}): Plugin {
  const frameworks = options.frameworks ?? [...TARGETS];
  if (options.framework && !frameworks.includes(options.framework)) {
    throw new Error(
      `multifront: framework '${options.framework}' is not one of the enabled frameworks (${frameworks.join(', ')}).`
    );
  }
  let config: ResolvedConfig | undefined;
  let vueCompiler: VueCompiler | undefined;
  return {
    name: 'multifront',
    // Before plugin-vue, plugin-react and plugin-svelte, so they only ever see plain component files.
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
    },
    buildEnd() {
      vueCompiler = undefined;
    },
    api: {
      get vueCompiler(): VueCompiler {
        if (!config) throw new Error('multifront: the Vue compiler is only available after Vite resolved its config.');
        vueCompiler ??= getVueCompiler(config.plugins, config.root);
        return vueCompiler;
      },
    },
  };
}
