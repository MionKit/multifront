import type {LanguagePlugin} from '@volar/language-server';
import {createConnection, createServer, createSimpleProject} from '@volar/language-server/node.js';
import {create as createCssService} from 'volar-service-css';
import type {URI} from 'vscode-uri';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {multifrontService} from './multifrontService.ts';

function fileName(uri: URI): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

// Volar's server keys scripts by URI; the plugin reads file names, as tsserver gives them.
function byUri(plugin: LanguagePlugin<string>): LanguagePlugin<URI> {
  return {
    getLanguageId: (uri) => plugin.getLanguageId(fileName(uri)),
    // The .ucf plugin reads no associated script.
    createVirtualCode: (uri, languageId, snapshot) =>
      plugin.createVirtualCode?.(fileName(uri), languageId, snapshot, {getAssociatedScript: () => undefined}),
  };
}

/**
 * The `.ucf` language server: CSS / SCSS in `<style>` and our own diagnostics. No TypeScript: in hybrid mode tsserver,
 * with our TypeScript plugin, serves every TypeScript feature, inside `.ucf` files too. No Vue compiler either: it only
 * types `$style` in the React code, which no service here reads.
 */
export function startServer(): void {
  const connection = createConnection();
  const server = createServer(connection);
  connection.listen();
  connection.onInitialize((params) => {
    const plugin = byUri(createUcfLanguagePlugin());
    return server.initialize(params, createSimpleProject([plugin]), [createCssService(), multifrontService]);
  });
  connection.onInitialized(server.initialized);
  connection.onShutdown(server.shutdown);
}
