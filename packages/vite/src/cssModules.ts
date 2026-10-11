import {AsyncLocalStorage} from 'node:async_hooks';
import {moduleClassName} from '@multifront/core';
import genericNames from 'generic-names';
import type {CSSModulesOptions, ResolvedConfig} from 'vite';
import {VUE_INCLUDE, splitId} from './ids.ts';

type ScopedNameGenerator = Extract<CSSModulesOptions['generateScopedName'], Function>;
type LightningcssOptions = NonNullable<ResolvedConfig['css']['lightningcss']>;

const VITE_CSS_PLUGIN = 'vite:css';

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

// Our `generateScopedName`: inside a `.ucf` block, `<local>_<scopeId>_<index>`; else the user's or Vite's own.
function postcssModules(modules: CSSModulesOptions, scopeIdOf: (file: string) => string): CSSModulesOptions {
  const other = viteScopedName(modules);
  const generateScopedName = (local: string, filename: string, css: string, ...rest: unknown[]) => {
    const style = compiling.getStore();
    if (style) return moduleClassName(local, scopeIdOf(style.file), style.index);
    // postcss-modules also passes the PostCSS node, which Vite's type leaves out.
    return (other as (...args: unknown[]) => string)(local, filename, css, ...rest);
  };
  return {...modules, generateScopedName};
}

// lightningcss reads `cssModules` once per file, so inside a `.ucf` block its pattern is the block's own names.
function lightningcssModules(options: LightningcssOptions, scopeIdOf: (file: string) => string): LightningcssOptions {
  const own = options.cssModules;
  return {
    ...options,
    get cssModules() {
      const style = compiling.getStore();
      if (!style || own === false) return own;
      // postcss-modules, which names the other targets' classes, leaves grid, container and custom idents alone.
      const pattern = `[local]_${scopeIdOf(style.file)}_${style.index}`;
      return {...(typeof own === 'object' ? own : {}), pattern, grid: false, container: false, customIdents: false};
    },
  };
}

/** Names the classes of plugin-vue's `.ucf` `<style module>` requests `<local>_<scopeId>_<index>`, as the other targets. */
export function composeCssModules(config: ResolvedConfig, scopeIdOf: (file: string) => string): void {
  const transform = config.plugins.find((plugin) => plugin.name === VITE_CSS_PLUGIN)?.transform;
  if (!transform || !('handler' in transform)) {
    throw new Error(`multifront: Vite's ${VITE_CSS_PLUGIN} plugin has no transform hook with a handler`);
  }
  const {handler} = transform;
  transform.handler = function (code, id, options) {
    const {path, query} = splitId(id);
    if (!VUE_INCLUDE.test(path)) return handler.call(this, code, id, options);
    return compiling.run({file: path, index: query.get('index') ?? '0'}, () => handler.call(this, code, id, options));
  };
  const {css} = config;
  if (css.transformer === 'lightningcss') css.lightningcss = lightningcssModules(css.lightningcss ?? {}, scopeIdOf);
  // A new object: a restart may reuse the user's, which must not find ours in it.
  else if (css.modules !== false) css.modules = postcssModules(css.modules ?? {}, scopeIdOf);
}
