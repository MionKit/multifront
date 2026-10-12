import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import type {LanguageServer} from './lsp.ts';

export const SVELTE_PLUGIN = 'typescript-svelte-plugin';

const require = createRequire(import.meta.url);
// `svelteserver --stdio`, as Svelte for VS Code starts it.
export const SVELTE_SERVER = join(dirname(require.resolve('svelte-language-server/package.json')), 'bin', 'server.js');
const SVELTE_CHECK = join(dirname(require.resolve('svelte-check/package.json')), 'bin', 'svelte-check');

interface SvelteCheckProblem {
  type: 'ERROR' | 'WARNING';
  filename: string; // relative to the app
  start: {line: number; character: number}; // 0-based
  message: string;
  code?: number | string;
}

/** The installed `svelte-check` on one app, with its `tsconfig.json`. */
export async function runSvelteCheck(app: string): Promise<{exitCode: number | null; problems: SvelteCheckProblem[]}> {
  const args = [SVELTE_CHECK, '--workspace', app, '--tsconfig', './tsconfig.json', '--output', 'machine-verbose'];
  // pnpm's bin shim sets NODE_PATH into the repo's packages; the source condition is for the app's vite config.
  const env = {
    ...process.env,
    NODE_PATH: undefined,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
  };
  const child = spawn(process.execPath, args, {cwd: app, env, stdio: ['ignore', 'pipe', 'inherit']});
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  // Each problem is `<timestamp> {json}`; START and COMPLETED lines are plain text.
  const problems = output
    .split('\n')
    .map((line) => line.slice(line.indexOf(' ') + 1))
    .filter((json) => json.startsWith('{'))
    .map((json) => JSON.parse(json) as SvelteCheckProblem);
  return {exitCode, problems};
}

/** Opens and saves one `.ucf` file in our language server; resolves to the log line its Svelte emit wrote. */
export async function saveUcf(server: LanguageServer, fileName: string): Promise<string> {
  const before = server.log.length;
  const document = await server.openTextDocument(fileName, 'ucf');
  await server.connection.sendNotification('textDocument/didSave', {textDocument: {uri: document.uri}});
  const deadline = Date.now() + 30_000;
  for (;;) {
    const line = server.log.slice(before).find(({message}) => message.includes('Svelte declarations'));
    if (line) return line.message;
    if (Date.now() > deadline) throw new Error(`no Svelte declarations logged after saving ${fileName}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
