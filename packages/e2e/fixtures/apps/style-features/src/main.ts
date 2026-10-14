// One framework per page (`?framework=react`), so a page holds only the CSS that framework's build imports.
const mounts: Record<string, () => Promise<unknown>> = {
  vue: () => import('./vue.ts'),
  react: () => import('./react.ts'),
  svelte: () => import('./svelte.ts'),
};

void mounts[new URLSearchParams(location.search).get('framework') ?? '']?.();
