import {startLanguageServer as forkLanguageServer} from '@volar/test-utils';
import type {LanguageServerHandle} from '@volar/test-utils';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export interface LanguageServer extends LanguageServerHandle {
  stop(): Promise<void>;
}

// The installed bin, so the server starts as another editor would start it.
const SERVER_BIN = join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'node_modules/@multifront/language-tools/bin/multifront-language-server.js'
);

interface LanguageServerOptions {
  server?: string; // a bundled server file, run as is; default: the bin, from source
  initializationOptions?: {typescript: {tsdk: string}};
}

/** Pulls diagnostics as VS Code does. */
export async function startLanguageServer(workspace: string, options: LanguageServerOptions = {}): Promise<LanguageServer> {
  let handle: LanguageServerHandle;
  if (options.server) handle = forkLanguageServer(options.server, workspace);
  else {
    // test-utils forks with `process.env` and replaces execArgv: NODE_OPTIONS is the only way in.
    const nodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${nodeOptions ?? ''} --conditions=source`.trim();
    try {
      handle = forkLanguageServer(SERVER_BIN, workspace);
    } finally {
      if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = nodeOptions;
    }
  }
  const kill = () => {
    handle.connection.dispose();
    handle.process.kill();
  };
  try {
    await handle.initialize(pathToFileURL(workspace).href, options.initializationOptions ?? {}, {
      textDocument: {diagnostic: {}},
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
  return Object.assign(handle, {stop});
}
