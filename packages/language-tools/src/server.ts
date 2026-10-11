import type {Connection, InitializeParams, LanguagePlugin, LanguageServicePlugin} from '@volar/language-server';
import {createConnection, createServer, createSimpleProject, loadTsdkByPath} from '@volar/language-server/node.js';
import {createVueLanguageServicePlugins} from '@vue/language-service';
import type * as ts from 'typescript';
import {create as createCssService} from 'volar-service-css';
import type {URI} from 'vscode-uri';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {multifrontService} from './multifrontService.ts';
import type {TypeScript} from './types.ts';
import {VUE_REQUESTS, vueRequestCommand} from './vueRequests.ts';

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

/** No TypeScript service: in hybrid mode tsserver, with our TS plugin, serves every TS feature, `.ucf` too. */
export function startServer(): void {
  const connection = createConnection();
  const server = createServer(connection);
  connection.listen();
  connection.onInitialize((params) => {
    const ts = loadTypeScript(params, connection);
    // No Vue compiler: it only types `$style` in the React code, which no service here reads.
    const plugin = byUri(createUcfLanguagePlugin({ts}));
    const services = [createCssService(), multifrontService, ...(ts ? vuePlugins(ts, connection) : [])];
    return server.initialize(params, createSimpleProject([plugin]), services);
  });
  connection.onInitialized(server.initialized);
  connection.onShutdown(server.shutdown);
}
