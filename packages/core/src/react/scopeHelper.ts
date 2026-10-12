/** The forwarding helper the Vite plugin serves as a virtual module, so every build bundles it once. */

export const SCOPE_HELPER_ID = 'virtual:multifront/scope-attrs';

export const SCOPE_ATTRS = '__ucfScopeAttrs';

export const WARN_FRAGMENT = '__ucfWarnFragment';

const SCOPE_ATTRS_CODE = `export function ${SCOPE_ATTRS}(props) {
  const attrs = {};
  for (const key in props) if (key.startsWith('data-v-')) attrs[key] = props[key];
  return attrs;
}
`;

// Mirrors Vue's multi-root warning; Svelte passes its own `problem` and `fix`.
const WARN_FRAGMENT_CODE = `const warned = new Set();
export function ${WARN_FRAGMENT}(props, name, problem = 'renders a fragment root', fix = 'Render one root element instead.') {
  if (warned.has(name)) return;
  const keys = Object.keys(${SCOPE_ATTRS}(props));
  if (keys.length === 0) return;
  warned.add(name);
  console.warn(
    \`[multifront] <\${name}> \${problem}, so no element receives \${keys.join(', ')} and its parent's scoped styles miss it. \${fix}\`
  );
}
`;

/** Plain JS: the id has no extension, so no TypeScript transform runs on it. */
export function scopeHelperCode(dev: boolean): string {
  return dev ? SCOPE_ATTRS_CODE + WARN_FRAGMENT_CODE : SCOPE_ATTRS_CODE;
}
