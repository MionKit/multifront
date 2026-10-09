/** Picks the `data-v-*` scope attributes a parent stamped on this component, so its root element can forward them. */
export function scopeAttrs(props: Readonly<Record<string, unknown>>): Record<string, ''> {
  const attrs: Record<string, ''> = {};
  for (const key in props) if (key.startsWith('data-v-')) attrs[key] = '';
  return attrs;
}
