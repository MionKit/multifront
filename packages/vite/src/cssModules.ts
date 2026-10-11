import {AsyncLocalStorage} from 'node:async_hooks';
import {moduleClassName} from '@multifront/core';
import genericNames from 'generic-names';
import type {CSSModulesOptions, ResolvedConfig} from 'vite';
import {VUE_INCLUDE, splitId} from './ids.ts';

type ScopedNameGenerator = Extract<CSSModulesOptions['generateScopedName'], Function>;

const VITE_CSS_PLUGIN = 'vite:css';
const CSS_MODULE = /\.module\.\w+$/;

const LIGHTNINGCSS_MODULES =
  "<style module> in the vue target needs css.transformer 'postcss', Vite's default: lightningcss would name its classes unlike the other targets";

// The `.ucf` `<style>` block Vite's CSS plugin is compiling: postcss-modules names a file it composes from with
// that file's path only, so the block reaches the generator through the async context.
const compiling = new AsyncLocalStorage<{file: string; index: string}>();

// string-hash 1.1.3, which postcss-modules' default generator uses.
function stringHash(text: string): number {
  let hash = 5381;
  for (let index = text.length; index;) hash = (hash * 33) ^ text.charCodeAt(--index);
  return hash >>> 0;
}

// The generator Vite's CSS modules use for these options (postcss-modules 9.0.1 `getScopedNameGenerator`).
function viteScopedName({generateScopedName, hashPrefix = ''}: CSSModulesOptions): ScopedNameGenerator {
  if (typeof generateScopedName === 'function') return generateScopedName;
  // postcss-modules reads the working directory per file.
  if (generateScopedName)
    return (local, filename) => genericNames(generateScopedName, {context: process.cwd(), hashPrefix})(local, filename);
  return (local, _filename, css) => {
    const line = css.substring(0, css.indexOf(`.${local}`)).split(/[\r\n]/).length;
    const hash = stringHash(hashPrefix + css).toString(36);
    return `_${local}_${hash.slice(0, 5)}_${line}`;
  };
}

/** Names the classes of plugin-vue's `.ucf` `<style module>` requests `<local>_<scopeId>_<index>`, as the other targets. */
export function composeCssModules(config: ResolvedConfig, scopeIdOf: (file: string) => string): void {
  const {modules, transformer} = config.css;
  // lightningcss takes one class name pattern for all files, which cannot give `<local>_<scopeId>_<index>`.
  const lightningcss = transformer === 'lightningcss';
  if (modules === false && !lightningcss) return;
  const transform = config.plugins.find((plugin) => plugin.name === VITE_CSS_PLUGIN)?.transform;
  if (!transform || !('handler' in transform))
    throw new Error(`multifront: Vite's ${VITE_CSS_PLUGIN} plugin has no transform hook with a handler`);
  const {handler} = transform;
  transform.handler = function (code, id, options) {
    const {path, query} = splitId(id);
    if (!VUE_INCLUDE.test(path)) return handler.call(this, code, id, options);
    if (lightningcss && CSS_MODULE.test(id)) this.error(`${path}: ${LIGHTNINGCSS_MODULES}`);
    return compiling.run({file: path, index: query.get('index') ?? '0'}, () => handler.call(this, code, id, options));
  };
  if (lightningcss || modules === false) return;
  const other = viteScopedName(modules ?? {});
  config.css.modules = {
    ...modules,
    // A new object: a restart may reuse the user's, which must not find ours in it.
    generateScopedName(local, filename, css, ...rest: unknown[]) {
      const style = compiling.getStore();
      if (style) return moduleClassName(local, scopeIdOf(style.file), style.index);
      // postcss-modules also passes the PostCSS node, which Vite's type leaves out.
      return (other as (...args: unknown[]) => string)(local, filename, css, ...rest);
    },
  };
}
