import genericNames from 'generic-names';
import type {CSSModulesOptions} from 'vite';

/** `css.modules.generateScopedName` as postcss-modules calls it. */
export type ScopedNameGenerator = (local: string, filename: string, css: string) => string;

// string-hash 1.1.3, which postcss-modules' default generator uses.
function stringHash(text: string): number {
  let hash = 5381;
  for (let index = text.length; index;) hash = (hash * 33) ^ text.charCodeAt(--index);
  return hash >>> 0;
}

/** The generator Vite's CSS modules use for these options (postcss-modules 9.0.1 `getScopedNameGenerator`). */
export function viteScopedName({generateScopedName, hashPrefix = ''}: CSSModulesOptions): ScopedNameGenerator {
  if (typeof generateScopedName === 'function') return generateScopedName;
  if (typeof generateScopedName === 'string') return genericNames(generateScopedName, {context: process.cwd(), hashPrefix});
  return (local, _filename, css) => {
    const line = css.substring(0, css.indexOf(`.${local}`)).split(/[\r\n]/).length;
    return `_${local}_${stringHash(hashPrefix + css)
      .toString(36)
      .slice(0, 5)}_${line}`;
  };
}
