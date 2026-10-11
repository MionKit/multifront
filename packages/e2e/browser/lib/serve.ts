import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer, preview, type Logger, type ResolvedServerUrls} from 'vite';
import {TMP_DIR} from '../../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp} from '../../build/lib/build.ts';

async function tempDir(prefix: string): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  return mkdtemp(join(TMP_DIR, prefix));
}

export function localUrl(urls: ResolvedServerUrls | null, appDir: string): string {
  const url = urls?.local[0];
  if (!url) throw new Error(`no local URL for ${appDir}`);
  return url;
}

/** Edit only a `copyApp()` copy, never the fixture itself. `logger` gets every line, whatever `logLevel` says. */
export async function startDev(appDir: string, logger?: Logger) {
  // Own cache per server: apps in one package share `node_modules/.vite` otherwise.
  const cacheDir = await tempDir('dev-cache-');
  // Held until close: the dep optimizer hashes NODE_ENV, so `test` back mid-server marks deps outdated and pages 504.
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const restore = async () => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    await rm(cacheDir, {recursive: true, force: true});
  };
  let server;
  try {
    server = await createServer({
      root: appDir,
      configLoader: APP_CONFIG_LOADER,
      cacheDir,
      logLevel: 'silent',
      customLogger: logger,
      server: {port: 0},
    });
  } catch (err) {
    await restore();
    throw err;
  }
  const close = async () => {
    try {
      // Vite's close never settles while its first crawl is running.
      await server.environments.client.waitForRequestsIdle();
      await server.close();
    } finally {
      await restore();
    }
  };
  try {
    await server.listen();
    return {url: localUrl(server.resolvedUrls, appDir), server, close};
  } catch (err) {
    await close();
    throw err;
  }
}

export async function buildAndPreview(appDir: string) {
  const outDir = await tempDir('preview-');
  const removeOut = () => rm(outDir, {recursive: true, force: true});
  let server;
  try {
    await buildApp(appDir, {build: {write: true, outDir, emptyOutDir: true}});
    server = await preview({
      root: appDir,
      configLoader: APP_CONFIG_LOADER,
      logLevel: 'silent',
      build: {outDir},
      preview: {port: 0},
    });
  } catch (err) {
    await removeOut();
    throw err;
  }
  const close = async () => {
    try {
      await server.close();
    } finally {
      await removeOut();
    }
  };
  try {
    return {url: localUrl(server.resolvedUrls, appDir), outDir, close};
  } catch (err) {
    await close();
    throw err;
  }
}
