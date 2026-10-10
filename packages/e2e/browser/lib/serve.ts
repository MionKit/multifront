import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer, preview, type ResolvedServerUrls} from 'vite';
import {TMP_DIR} from '../../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp} from '../../build/lib/build.ts';

async function tempDir(prefix: string): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  return mkdtemp(join(TMP_DIR, prefix));
}

function localUrl(urls: ResolvedServerUrls | null, appDir: string): string {
  const url = urls?.local[0];
  if (!url) throw new Error(`no local URL for ${appDir}`);
  return url;
}

/** A real dev server of the app on a free port. Edit only a `copyApp()` copy. */
export async function startDev(appDir: string) {
  // Own cache per server: apps in one package share `node_modules/.vite` otherwise.
  const cacheDir = await tempDir('dev-cache-');
  // Vite's dep optimizer hashes NODE_ENV whenever it runs: a change while the server lives (Vitest's `test` back)
  // marks the optimized deps outdated, and the page gets 504s.
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const restore = async () => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    await rm(cacheDir, {recursive: true, force: true});
  };
  let server;
  try {
    server = await createServer({root: appDir, configLoader: APP_CONFIG_LOADER, cacheDir, logLevel: 'silent', server: {port: 0}});
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

/** A production build of the app, served by `vite preview` on a free port. */
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
