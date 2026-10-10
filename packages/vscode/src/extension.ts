import {getTsdk} from '@volar/vscode';
import * as vscode from 'vscode';
import {LanguageClient, TransportKind} from 'vscode-languageclient/node.js';
import type {LanguageClientOptions, ServerOptions} from 'vscode-languageclient/node.js';

let client: LanguageClient | undefined;

/** tsserver loads our TypeScript plugin from the plugin pack on its own. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The TypeScript extension activates on JS and TS files only: a lone .ucf file would get no tsserver features.
  await vscode.extensions.getExtension('vscode.typescript-language-features')?.activate();
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
  // stop() throws on a client that failed to start or is still starting.
  if (client?.isRunning()) await client.stop();
}
