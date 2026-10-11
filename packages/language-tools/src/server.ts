import type {LanguagePlugin} from '@volar/language-server';
import {createConnection, createServer, createSimpleProject, loadTsdkByPath} from '@volar/language-server/node.js';
import {create as createCssService} from 'volar-service-css';
import type {URI} from 'vscode-uri';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {multifrontService} from './multifrontService.ts';

/** What an editor sends: VS Code's extension passes the TypeScript it runs. */
interface InitializationOptions {
  typescript?: {tsdk?: string};
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
  };
}

/** No TypeScript: in hybrid mode tsserver, with our TS plugin, serves every TypeScript feature, `.ucf` files too. */
export function startServer(): void {
  const connection = createConnection();
  const server = createServer(connection);
  connection.listen();
  connection.onInitialize((params) => {
    const {tsdk} = (params.initializationOptions as InitializationOptions | undefined)?.typescript ?? {};
    // The `<vue>` code needs TypeScript; without a tsdk the server serves the other blocks only.
    const ts = tsdk ? loadTsdkByPath(tsdk, params.locale).typescript : undefined;
    // No Vue compiler: it only types `$style` in the React code, which no service here reads.
    const plugin = byUri(createUcfLanguagePlugin({ts, compilerOptions: {}}));
    return server.initialize(params, createSimpleProject([plugin]), [createCssService(), multifrontService]);
  });
  connection.onInitialized(server.initialized);
  connection.onShutdown(server.shutdown);
}
