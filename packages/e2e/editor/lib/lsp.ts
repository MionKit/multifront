import {startLanguageServer as forkLanguageServer} from '@volar/test-utils';
import type {LanguageServerHandle} from '@volar/test-utils';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export interface LanguageServer extends LanguageServerHandle {
  stop(): Promise<void>;
}

// The bin as installed, so the test starts the server the way another editor does.
const SERVER_BIN = join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'node_modules/@multifront/language-tools/bin/multifront-language-server.js'
);

/** The real `multifront-language-server --stdio` over LSP, from source, with diagnostics pulled as VS Code does. */
export async function startLanguageServer(workspace: string): Promise<LanguageServer> {
  // test-utils forks with `process.env` and replaces execArgv, so the condition can only come through NODE_OPTIONS.
  const nodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${nodeOptions ?? ''} --conditions=source`.trim();
  let handle: LanguageServerHandle;
  try {
    handle = forkLanguageServer(SERVER_BIN, workspace);
  } finally {
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
  }
  const kill = () => {
    handle.connection.dispose();
    handle.process.kill();
  };
  try {
    await handle.initialize(pathToFileURL(workspace).href, {}, {textDocument: {diagnostic: {}}, workspace: {diagnostics: {}}});
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
