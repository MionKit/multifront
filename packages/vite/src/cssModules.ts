import {moduleClassName} from '@multifront/core';
import genericNames from 'generic-names';
import type {CSSModulesOptions, ResolvedConfig} from 'vite';
import {splitId} from './ids.ts';

type ScopedNameGenerator = Extract<CSSModulesOptions['generateScopedName'], Function>;

const UCF_STYLE = /\.ucf$/;

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
    const hash = stringHash(hashPrefix + css)
      .toString(36)
      .slice(0, 5);
    return `_${local}_${hash}_${line}`;
  };
}

/** Names the classes of plugin-vue's `.ucf` `<style module>` requests `<local>_<scopeId>_<index>`, as the other targets. */
export function composeCssModules(config: ResolvedConfig, scopeIdOf: (file: string) => string): void {
  const {modules} = config.css;
  if (modules === false) return;
  const other = viteScopedName(modules ?? {});
  config.css.modules = {
    ...modules,
    // A new object: a restart may reuse the user's, which must not find ours in it.
    generateScopedName(local, filename, css, ...rest: unknown[]) {
      const {path, query} = splitId(filename);
      if (UCF_STYLE.test(path)) return moduleClassName(local, scopeIdOf(path), query.get('index') ?? 0);
      // postcss-modules also passes the PostCSS node, which Vite's type leaves out.
      return (other as (...args: unknown[]) => string)(local, filename, css, ...rest);
    },
  };
}
