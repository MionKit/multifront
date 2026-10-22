/** The forwarding helper the Vite plugin serves as a virtual module, so every build bundles it once. */

export const SCOPE_HELPER_ID = 'virtual:multifront/scope-attrs';

/** Where a Svelte library package ships that module, from its root. */
export const LIBRARY_SCOPE_HELPER = '_front/scopeAttrs.js';

export const SCOPE_ATTRS = '__frontScopeAttrs';

export const WARN_FRAGMENT = '__frontWarnFragment';

export const MERGE_CLASS = '__frontClass';

export const MERGE_STYLE = '__frontStyle';

export const MERGE_SVELTE_CLASS = '__frontSvelteClass';

export const MERGE_REF = '__frontRef';

// `keys`: root props a Svelte root lacks, passed on only when given: beside a spread, `class={undefined}` renders `class=""`.
const SCOPE_ATTRS_CODE = `export function ${SCOPE_ATTRS}(props, ...keys) {
  const attrs = {};
  for (const key in props) if (key.startsWith('data-v-')) attrs[key] = props[key];
  for (const key of keys) if (props[key] != null) attrs[key] = props[key];
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

// Root props (spec 3.5): style is a React object or Svelte text; Svelte flattens any class value.
const ROOT_PROPS_CODE = `export function ${MERGE_CLASS}(own, extra) {
  return extra ? (own ? \`\${own} \${extra}\` : extra) : own;
}
export function ${MERGE_SVELTE_CLASS}(own, extra) {
  if (!extra) return own;
  if (!own) return extra;
  return typeof own === 'string' && typeof extra === 'string' ? \`\${own} \${extra}\` : [own, extra];
}
export function ${MERGE_STYLE}(own, extra) {
  if (!extra) return own;
  if (!own) return extra;
  return typeof own === 'object' && typeof extra === 'object' ? {...own, ...extra} : \`\${own}; \${extra}\`;
}
// One merged ref per pair, so stable refs are not detached and attached again on every render.
const mergedRefs = new WeakMap();
function attach(ref, node) {
  if (typeof ref === 'function') {
    const cleanup = ref(node);
    return typeof cleanup === 'function' ? cleanup : () => ref(null);
  }
  ref.current = node;
  return () => {
    ref.current = null;
  };
}
export function ${MERGE_REF}(own, extra) {
  if (!own || !extra) return own || extra;
  let byExtra = mergedRefs.get(own);
  if (!byExtra) mergedRefs.set(own, (byExtra = new WeakMap()));
  let merged = byExtra.get(extra);
  if (!merged) {
    merged = (node) => {
      const cleanups = [attach(own, node), attach(extra, node)];
      return () => cleanups.forEach((cleanup) => cleanup());
    };
    byExtra.set(extra, merged);
  }
  return merged;
}
`;

/** Plain JS: the id has no extension, so no TypeScript transform runs on it. */
export function scopeHelperCode(dev: boolean): string {
  return SCOPE_ATTRS_CODE + ROOT_PROPS_CODE + (dev ? WARN_FRAGMENT_CODE : '');
}
