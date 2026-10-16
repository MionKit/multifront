import type {Connection, InitializeParams, LanguagePlugin, LanguageServer, LanguageServicePlugin} from '@volar/language-server';
import {createConnection, createServer, createSimpleProject, loadTsdkByPath} from '@volar/language-server/node.js';
import {createVueLanguageServicePlugins} from '@vue/language-service';
import {existsSync} from 'node:fs';
import {join, relative} from 'node:path';
import {splitBlocks} from '@multifront/core';
import type * as ts from 'typescript';
import {create as createCssService} from 'volar-service-css';
import {URI} from 'vscode-uri';
import {workspaceRoot} from './files.ts';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {multifrontService} from './multifrontService.ts';
import {formatService} from './server/format.ts';
import {lintService} from './server/lint.ts';
import {emitSvelteTypes} from './svelteDeclarations.ts';
import {svelteBlocksService, svelteHtmlService} from './svelteMarkupService.ts';
import type {ServerOptions, TypeScript} from './types.ts';
import {VUE_REQUESTS, vueRequestCommand} from './blocks/vue.ts';

export type {ServerOptions} from './types.ts';

type VueClient = NonNullable<Parameters<typeof createVueLanguageServicePlugins>[1]>;

/** What an editor sends: VS Code's extension passes the TypeScript it runs. */
interface InitializationOptions {
  typescript?: {tsdk?: unknown};
}

function fileName(uri: URI): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

// Volar's server keys scripts by URI; the plugin reads tsserver-style file names.
function byUri(plugin: LanguagePlugin<string>): LanguagePlugin<URI> {
  return {
    getLanguageId: (uri) => plugin.getLanguageId(fileName(uri)),
    // The .ucf plugin reads no associated script.
    createVirtualCode: (uri, languageId, snapshot) =>
      plugin.createVirtualCode?.(fileName(uri), languageId, snapshot, {getAssociatedScript: () => undefined}),
    updateVirtualCode: (uri, code, snapshot) =>
      plugin.updateVirtualCode?.(fileName(uri), code, snapshot, {getAssociatedScript: () => undefined}),
    disposeVirtualCode: (uri, code) => plugin.disposeVirtualCode?.(fileName(uri), code),
  };
}

// The `<vue>` code needs TypeScript; without a usable tsdk the server still serves every other block.
function loadTypeScript(params: InitializeParams, connection: Connection): TypeScript | undefined {
  const {tsdk} = (params.initializationOptions as InitializationOptions | undefined)?.typescript ?? {};
  if (typeof tsdk !== 'string') return undefined;
  try {
    return loadTsdkByPath(tsdk, params.locale).typescript;
  } catch (err) {
    connection.console.warn(`multifront: no TypeScript from tsdk ${tsdk}, no <vue> code (${String(err)})`);
    return undefined;
  }
}

// As Vue's server: each request goes to the client, whose extension runs it in tsserver and sends the body back.
function tsserverClient(connection: Connection): VueClient {
  const waiting = new Map<number, (body: unknown) => void>();
  let lastId = 0;
  connection.onNotification('tsserver/response', ([id, body]: [number, unknown]) => {
    waiting.get(id)?.(body);
    waiting.delete(id);
  });
  const relayed = Object.fromEntries(
    VUE_REQUESTS.map((name) => [
      name,
      (...args: unknown[]) =>
        new Promise((resolve) => {
          const id = ++lastId;
          waiting.set(id, resolve);
          void connection.sendNotification('tsserver/request', [id, vueRequestCommand(name), args]);
        }),
    ])
  );
  // Every other request answers nothing, as with Vue's own default client.
  return new Proxy(relayed, {get: (target, key) => target[key as string] ?? (() => undefined)}) as unknown as VueClient;
}

// Vue's `css` plugin would answer our `<style>` codes a second time.
function vuePlugins(typescript: TypeScript, connection: Connection): LanguageServicePlugin[] {
  return createVueLanguageServicePlugins(typescript as typeof ts, tsserverClient(connection)).filter(({name}) => name !== 'css');
}

// Waits out a burst of saves (Save All, auto-save): each emit covers the whole folder.
const EMIT_DELAY = 100;

// Svelte's own tools never load our TypeScript plugin: they read these declarations (`rootDirs`).
function emitOnSave(server: LanguageServer, ts: TypeScript, svelteTypesRoot: string | undefined): void {
  const {connection} = server;
  const emit = (root: string): void => {
    const outDir = join(root, '.ucf', 'svelte');
    try {
      const written = emitSvelteTypes({root, outDir, ts, svelteTypesRoot});
      connection.console.info(`multifront: wrote ${written.length} Svelte declarations to ${outDir}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      connection.console.warn(`multifront: no Svelte declarations for ${root} (${reason})`);
    }
  };
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  server.documents.onDidSave(({document}) => {
    const uri = URI.parse(document.uri);
    if (uri.scheme !== 'file' || !uri.fsPath.endsWith('.ucf')) return;
    const fileName = uri.fsPath;
    const root = workspaceRoot(fileName, server.workspaceFolders.all);
    if (!root) return;
    // A declaration with no block left is deleted by the emit.
    const declared = existsSync(join(root, '.ucf', 'svelte', `${relative(root, fileName)}.d.ts`));
    if (!declared && !splitBlocks(document.getText(), fileName).targets.svelte) return;
    clearTimeout(pending.get(root));
    pending.set(
      root,
      setTimeout(() => {
        pending.delete(root);
        emit(root);
      }, EMIT_DELAY)
    );
  });
}

/** No TypeScript service: in hybrid mode tsserver, with our TS plugin, serves every TS feature, `.ucf` too. */
export function startServer(options: ServerOptions = {}): void {
  const connection = createConnection();
  const server = createServer(connection);
  connection.listen();
  connection.onInitialize((params) => {
    const ts = loadTypeScript(params, connection);
    if (ts) {
      options.onTypeScript?.(ts);
      emitOnSave(server, ts, options.svelteTypesRoot);
    }
    // No Vue compiler: it only types `$style` in the React code, which no service here reads.
    const plugin = byUri(createUcfLanguagePlugin({ts}));
    const services = [
      formatService(server),
      createCssService(),
      multifrontService,
      lintService(server),
      svelteHtmlService(),
      svelteBlocksService,
      ...(ts ? vuePlugins(ts, connection) : []),
    ];
    return server.initialize(params, createSimpleProject([plugin]), services);
  });
  connection.onInitialized(server.initialized);
  connection.onShutdown(server.shutdown);
}
