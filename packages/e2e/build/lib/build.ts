import {join} from 'node:path';
import {createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {BuildContext} from '@multifront/core';
import {build, createServer, mergeConfig, type ESTree, type InlineConfig, type Rolldown, type ViteDevServer} from 'vite';
import type {Plugin} from 'vite';
import {readComponent} from '../../fixtures/index.ts';

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

export function rejection<Failure>(promise: Promise<unknown>): Promise<Failure> {
  return promise.then(
    () => {
      throw new Error('did not fail');
    },
    (err: Failure) => err
  );
}

/** A fixture component's build context, as a production build of the app at `root` makes it. */
export async function componentContext(root: string, name: string): Promise<BuildContext> {
  const {filename, source} = readComponent(name);
  return createBuildContext(splitBlocks(source, filename), {root, compiler: loadVueCompiler(root), production: true});
}

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

export async function buildCode(root: string, config: InlineConfig = {}) {
  const {chunks, css} = await buildApp(root, config);
  return {code: chunks.map((chunk) => chunk.code).join('\n'), css: css.join('\n')};
}

/** Uses the app's own `vite.config.ts` unless `config` sets `configFile: false`. */
export async function withDevServer<Result>(root: string, config: InlineConfig, run: (server: ViteDevServer) => Promise<Result>) {
  return withNodeEnv('development', async () => {
    const base: InlineConfig = {
      root,
      logLevel: 'silent',
      configLoader: APP_CONFIG_LOADER,
      cacheDir: join(root, '.vite'),
      server: {middlewareMode: true, ws: false},
      // No dep optimizer: when it finishes before transformRequest under load, the request never resolves.
      optimizeDeps: {noDiscovery: true},
    };
    const server = await createServer(mergeConfig(base, config));
    try {
      return await run(server);
    } finally {
      await server.close();
    }
  });
}

/** `next()` settles with the final client module ids of the next change to `file`. */
export function hotUpdatesOf(file: string) {
  let settle: ((ids: string[]) => void) | undefined;
  const plugin: Plugin = {
    name: 'hot-updated',
    enforce: 'post',
    hotUpdate: {
      order: 'post',
      handler({file: changed, modules}) {
        if (this.environment.name === 'client' && changed === file) settle?.(modules.flatMap((mod) => mod.id ?? []));
      },
    },
  };
  return {plugin, next: () => new Promise<string[]>((resolve) => void (settle = resolve))};
}

/** plugin-vue's `__scopeId` in a component module; matches dev and build output. */
export function exportedScopeId(code: string): string | undefined {
  return /\[\s*["']__scopeId["']\s*,\s*["'](data-v-[0-9a-f]+)["']\s*\]/.exec(code)?.[1];
}

export function keyName(key: ESTree.ImportAttributeKey | ESTree.PropertyKey): string | undefined {
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}
