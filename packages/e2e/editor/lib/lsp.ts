import {startLanguageServer as forkLanguageServer} from '@volar/test-utils';
import type {LanguageServerHandle} from '@volar/test-utils';
import {createRequire} from 'node:module';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {Tsserver} from './tsserver.ts';

/** LSP `window/logMessage`; type 1 is an error, 2 a warning. */
interface LogMessage {
  type: number;
  message: string;
}

export interface LanguageServer extends LanguageServerHandle {
  log: LogMessage[]; // every message the server logged; a plugin that throws logs a warning
  stop(): Promise<void>;
}

// The installed bin, so the server starts as another editor would start it.
const SERVER_BIN = join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'node_modules/@multifront/language-tools/bin/multifront-language-server.js'
);

// Stands in for the extension's tsdk: a TypeScript lib folder.
export const TSDK = dirname(createRequire(import.meta.url).resolve('typescript'));

interface LanguageServerOptions {
  server?: string; // a bundled server file, run as is; default: the bin, from source
  source?: boolean; // `--conditions=source`; default: only for the bin
  initializationOptions?: {typescript: {tsdk: string}};
}

/** Pulls diagnostics as VS Code does; several workspace folders make a multi-root workspace. */
export async function startLanguageServer(
  workspace: string | string[],
  options: LanguageServerOptions = {}
): Promise<LanguageServer> {
  const folders = [workspace].flat();
  // test-utils forks with `process.env` and replaces execArgv: the env is the only way in.
  const saved = {NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH};
  // pnpm's bin shim sets NODE_PATH into the repo's packages: a bundle missing a dependency would still find it.
  delete process.env.NODE_PATH;
  if (options.source ?? !options.server) process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ?? ''} --conditions=source`.trim();
  let handle: LanguageServerHandle;
  try {
    handle = forkLanguageServer(options.server ?? SERVER_BIN, folders[0]!);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const log: LogMessage[] = [];
  // Replaces test-utils' own handler, which only prints.
  handle.connection.onNotification('window/logMessage', (params: LogMessage) => log.push(params));
  const kill = () => {
    handle.connection.dispose();
    handle.process.kill();
  };
  try {
    const uris = folders.map((folder) => ({uri: pathToFileURL(folder).href, name: basename(folder)}));
    await handle.initialize(Array.isArray(workspace) ? uris : uris[0]!.uri, options.initializationOptions ?? {}, {
      // VS Code's: Vue's template completions are snippets.
      textDocument: {diagnostic: {}, completion: {completionItem: {snippetSupport: true}}},
      workspace: {diagnostics: {}},
    });
  } catch (err) {
    kill();
    throw err;
  }
  const stop = async () => {
    try {
      await handle.shutdown();
      await handle.connection.sendNotification('exit');
    } finally {
      kill();
    }
  };
  return Object.assign(handle, {log, stop});
}

/** Relays the server's `tsserver/request` notifications to a tsserver, as the extension does. */
export function relayTsserver(server: LanguageServer, tsserver: Tsserver): void {
  server.connection.onNotification('tsserver/request', async ([id, command, args]: [number, string, unknown[]]) => {
    // A failing handler answers nothing, which Vue reads as an empty list: the log keeps it visible.
    const body = await tsserver
      .request(command, args)
      .catch((err: Error) => void server.log.push({type: 1, message: err.message}));
    await server.connection.sendNotification('tsserver/response', [id, body]);
  });
}
