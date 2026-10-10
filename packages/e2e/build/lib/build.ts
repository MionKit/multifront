import {build, mergeConfig, type ESTree, type InlineConfig, type Rolldown} from 'vite';

/** plugin-vue picks its dev or production scope id from NODE_ENV. */
export async function withNodeEnv<Result>(mode: string, run: () => Promise<Result>): Promise<Result> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

// The other loaders resolve `@multifront/vite` to its `dist/`, which tests never build.
export const APP_CONFIG_LOADER = 'native';

/** Uses the app's own `vite.config.ts` unless `config` sets `configFile: false`. */
export async function buildApp(root: string, config: InlineConfig = {}) {
  // Vitest sets NODE_ENV=test and Vite keeps it, which would give plugin-vue's dev scope id, not a real build's.
  const base: InlineConfig = {root, logLevel: 'silent', configLoader: APP_CONFIG_LOADER, build: {write: false, minify: false}};
  const result = await withNodeEnv('production', () => build(mergeConfig(base, config)));
  const bundle = Array.isArray(result) ? result[0]! : result;
  if (!('output' in bundle)) throw new Error('vite.build() returned a watcher');
  return {
    chunks: bundle.output.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk'),
    css: bundle.output
      .filter((file): file is Rolldown.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'))
      .map((asset) => (typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source))),
  };
}

/** plugin-vue's `__scopeId` in a component module; matches dev and build output. */
export function exportedScopeId(code: string): string | undefined {
  return /\[\s*["']__scopeId["']\s*,\s*["'](data-v-[0-9a-f]+)["']\s*\]/.exec(code)?.[1];
}

/** The name of an import attribute or object key, unless it is computed. */
export function keyName(key: ESTree.ImportAttributeKey | ESTree.PropertyKey): string | undefined {
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}
