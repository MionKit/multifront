import type {Connection, InitializeParams, LanguagePlugin} from '@volar/language-server';
import {createConnection, createServer, createSimpleProject, loadTsdkByPath} from '@volar/language-server/node.js';
import {create as createCssService} from 'volar-service-css';
import type {URI} from 'vscode-uri';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {multifrontService} from './multifrontService.ts';
import type {TypeScript} from './types.ts';

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

/** No TypeScript service: in hybrid mode tsserver, with our TS plugin, serves every TypeScript feature, `.ucf` files too. */
export function startServer(): void {
  const connection = createConnection();
  const server = createServer(connection);
  connection.listen();
  connection.onInitialize((params) => {
    const ts = loadTypeScript(params, connection);
    // No Vue compiler: it only types `$style` in the React code, which no service here reads.
    const plugin = byUri(createUcfLanguagePlugin({ts}));
    return server.initialize(params, createSimpleProject([plugin]), [createCssService(), multifrontService]);
  });
  connection.onInitialized(server.initialized);
  connection.onShutdown(server.shutdown);
}
