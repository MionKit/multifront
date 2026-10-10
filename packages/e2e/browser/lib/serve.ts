import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer, preview, type ViteDevServer} from 'vite';
import {TMP_DIR} from '../../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp, withNodeEnv} from '../../build/lib/build.ts';

async function tempDir(prefix: string): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  return mkdtemp(join(TMP_DIR, prefix));
}

function localUrl(urls: {local: string[]} | null, appDir: string): string {
  const url = urls?.local[0];
  if (!url) throw new Error(`no local URL for ${appDir}`);
  return url;
}

/** A real dev server of the app on a free port. Edit only a `copyApp()` copy. */
export async function startDev(appDir: string): Promise<{url: string; server: ViteDevServer; close(): Promise<void>}> {
  // Own cache per server: apps in one package share `node_modules/.vite` otherwise.
  const cacheDir = await tempDir('dev-cache-');
  try {
    const server = await withNodeEnv('development', async () => {
      const dev = await createServer({
        root: appDir,
        configLoader: APP_CONFIG_LOADER,
        cacheDir,
        logLevel: 'silent',
        server: {port: 0},
      });
      return dev.listen();
    });
    const close = async () => {
      try {
        // Vite's close never settles while its first crawl is running.
        await server.environments.client.waitForRequestsIdle();
        await server.close();
      } finally {
        await rm(cacheDir, {recursive: true, force: true});
      }
    };
    return {url: localUrl(server.resolvedUrls, appDir), server, close};
  } catch (err) {
    await rm(cacheDir, {recursive: true, force: true});
    throw err;
  }
}

/** A production build of the app, served by `vite preview` on a free port. */
export async function buildAndPreview(appDir: string): Promise<{url: string; outDir: string; close(): Promise<void>}> {
  const outDir = await tempDir('preview-');
  try {
    await buildApp(appDir, {build: {write: true, outDir, emptyOutDir: true}});
    const server = await preview({
      root: appDir,
      configLoader: APP_CONFIG_LOADER,
      logLevel: 'silent',
      build: {outDir},
      preview: {port: 0},
    });
    const close = async () => {
      try {
        await server.close();
      } finally {
        await rm(outDir, {recursive: true, force: true});
      }
    };
    return {url: localUrl(server.resolvedUrls, appDir), outDir, close};
  } catch (err) {
    await rm(outDir, {recursive: true, force: true});
    throw err;
  }
}
