import {build, type Rolldown} from 'vite';

/** Runs `run` with NODE_ENV set to `mode`: plugin-vue picks its dev or production scope id from it. */
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

/** A production `vite.build()` of the app at `root`, with its own `vite.config.ts`, nothing written to disk. */
export async function buildApp(root: string) {
  // Vitest sets NODE_ENV=test and Vite keeps it, which would give plugin-vue's dev scope id, not a real build's.
  const result = await withNodeEnv('production', () => build({root, logLevel: 'silent', build: {write: false, minify: false}}));
  const bundle = Array.isArray(result) ? result[0]! : result;
  if (!('output' in bundle)) throw new Error('vite.build() returned a watcher');
  return {
    chunks: bundle.output.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk'),
    css: bundle.output
      .filter((file): file is Rolldown.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'))
      .map((asset) => (typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source))),
  };
}

/** The `data-v-…` value plugin-vue passes as `__scopeId` in a component module, dev or build. */
export function exportedScopeId(code: string): string | undefined {
  return /\[\s*["']__scopeId["']\s*,\s*["'](data-v-[0-9a-f]+)["']\s*\]/.exec(code)?.[1];
}
