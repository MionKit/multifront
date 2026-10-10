import {getTsdk} from '@volar/vscode';
import type * as vscode from 'vscode';
import {LanguageClient, TransportKind} from 'vscode-languageclient/node.js';
import type {LanguageClientOptions, ServerOptions} from 'vscode-languageclient/node.js';

let client: LanguageClient | undefined;

/** Starts our language server on `.ucf` files; tsserver loads our TypeScript plugin from the plugin pack on its own. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // VS Code's built-in TypeScript, or the workspace one when the user picked it.
  const tsdk = (await getTsdk(context))?.tsdk;
  const module = context.asAbsolutePath('dist/server.cjs');
  const serverOptions: ServerOptions = {
    run: {module, transport: TransportKind.ipc},
    debug: {module, transport: TransportKind.ipc, options: {execArgv: ['--nolazy', '--inspect=6009']}},
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{language: 'ucf'}],
    initializationOptions: {typescript: {tsdk}},
  };
  client = new LanguageClient('multifront', 'multifront', serverOptions, clientOptions);
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
