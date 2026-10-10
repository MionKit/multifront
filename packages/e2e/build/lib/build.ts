import {build, type Rolldown} from 'vite';

export interface BuiltApp {
  chunks: Rolldown.OutputChunk[];
  cssAssets: {fileName: string; css: string}[];
}

/** A production `vite.build()` of the app at `root`, with its own `vite.config.ts`, nothing written to disk. */
export async function buildApp(root: string): Promise<BuiltApp> {
  // Vitest sets NODE_ENV=test and Vite keeps it, which would give plugin-vue's dev scope id, not a real build's.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build({root, logLevel: 'silent', build: {write: false, minify: false}});
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
  const bundle = Array.isArray(result) ? result[0]! : result;
  if (!('output' in bundle)) throw new Error('vite.build() returned a watcher');
  const chunks = bundle.output.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk');
  const cssAssets = bundle.output
    .filter((file): file is Rolldown.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'))
    .map((asset) => ({
      fileName: asset.fileName,
      css: typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source),
    }));
  return {chunks, cssAssets};
}

/** The `data-v-…` value plugin-vue passes as `__scopeId` in a component module, dev or build. */
export function exportedScopeId(code: string): string | undefined {
  return /\[\s*["']__scopeId["']\s*,\s*["'](data-v-[0-9a-f]+)["']\s*\]/.exec(code)?.[1];
}
