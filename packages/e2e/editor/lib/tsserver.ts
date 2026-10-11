import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {locate as lineAndColumn, splitBlocks} from '@multifront/core';
import type {BlockTag} from '@multifront/core';
import type * as ts from 'typescript';

export type TsDiagnostic = ts.server.protocol.Diagnostic;
export type TsLocation = ts.server.protocol.Location;
export type TsDefinitions = ts.server.protocol.FileSpanWithContext[];
export type TsQuickInfo = ts.server.protocol.QuickInfoResponseBody;

export interface Component {
  filename: string;
  source: string;
}

export interface Tsserver {
  request<Body = unknown>(command: string, args?: object): Promise<Body>;
  diagnostics(file: string): Promise<TsDiagnostic[]>; // syntactic, then semantic
  stop(): Promise<void>;
}

interface TsserverOptions {
  cwd: string;
  plugins: string[]; // global plugins
  probeLocations?: string[]; // searched for plugins first; default packages/e2e, where they are installed
  // No source condition, no workspace package next to tsserver.js: only the probe locations give plugins.
  isolated?: boolean;
  logFile?: string;
}

const TSSERVER = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
export const E2E_DIR = fileURLToPath(new URL('../..', import.meta.url));
// Symlinks kept: tsserver's own `../../..` plugin lookup is root node_modules, with no workspace package in it.
// The real path's `.pnpm/node_modules` holds them all.
const ROOT_TSSERVER = join(E2E_DIR, '..', '..', 'node_modules', 'typescript', 'lib', 'tsserver.js');
const HEADER = 'Content-Length: ';

/** tsserver's 1-based location of `needle` in `source`, `shift` characters past its start. */
export function locate(source: string, needle: string, shift = 0): TsLocation {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`${needle} not found`);
  const before = source.slice(0, index + shift).split('\n');
  return {line: before.length, offset: before.at(-1)!.length + 1};
}

export function offsetAt(source: string, {line, offset}: TsLocation): number {
  const lines = source.split('\n').slice(0, line - 1);
  return lines.reduce((sum, text) => sum + text.length + 1, 0) + offset - 1;
}

/** tsserver's location of a source offset, as core's `locate` lines and columns it. */
export function tsLocation(source: string, offset: number): TsLocation {
  const {line, column} = lineAndColumn(source, offset);
  return {line, offset: column + 1};
}

export function inBlock({filename, source}: Component, tag: BlockTag, {file, start}: {file: string; start: TsLocation}): boolean {
  const block = splitBlocks(source, filename).blocks.find(({type}) => type === tag);
  const offset = offsetAt(source, start);
  return !!block && file === filename && offset >= block.contentStart && offset < block.contentEnd;
}

export function open(server: Tsserver, files: Component[]): Promise<unknown> {
  return server.request('updateOpen', {openFiles: files.map(({filename, source}) => ({file: filename, fileContent: source}))});
}

/** The real tsserver over its stdio protocol; plugins run from source unless isolated, as the workspace links them. */
export function startTsserver(options: TsserverOptions): Tsserver {
  const {cwd, plugins, probeLocations = [E2E_DIR], isolated = false, logFile} = options;
  const args = [
    ...(isolated ? ['--preserve-symlinks', '--preserve-symlinks-main', ROOT_TSSERVER] : ['--conditions=source', TSSERVER]),
    '--disableAutomaticTypingAcquisition',
  ];
  if (plugins.length > 0) args.push('--globalPlugins', plugins.join(','), '--pluginProbeLocations', probeLocations.join(','));
  if (logFile) args.push('--logVerbosity', 'normal', '--logFile', logFile);
  // pnpm's bin shim sets NODE_PATH into the repo's packages: a project outside the repo would resolve them.
  const env = {...process.env, NODE_PATH: undefined};
  const child = spawn(process.execPath, args, {cwd, env, stdio: ['pipe', 'pipe', 'inherit']});
  const pending = new Map<number, {resolve(body: unknown): void; reject(err: Error): void}>();
  let seq = 0;
  let buffer = Buffer.alloc(0);

  // Each message is `Content-Length: <bytes>\r\n\r\n<json>`; events come between the responses.
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(buffer.subarray(HEADER.length, headerEnd).toString());
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const message = JSON.parse(buffer.subarray(start, start + length).toString()) as ts.server.protocol.Message;
      buffer = buffer.subarray(start + length);
      if (message.type !== 'response') continue;
      const response = message as ts.server.protocol.Response;
      const waiting = pending.get(response.request_seq);
      pending.delete(response.request_seq);
      if (response.success) waiting?.resolve(response.body);
      else waiting?.reject(new Error(`tsserver ${response.command}: ${response.message}`));
    }
  });
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // A crash closes stdin: the write fails there, and every waiting request is rejected below.
  child.stdin.on('error', () => {});
  void exited.then(() => {
    for (const waiting of pending.values()) waiting.reject(new Error('tsserver exited'));
  });

  const request = <Body>(command: string, args?: object): Promise<Body> =>
    new Promise<Body>((resolve, reject) => {
      if (!running()) return reject(new Error('tsserver exited'));
      seq += 1;
      pending.set(seq, {resolve: resolve as (body: unknown) => void, reject});
      child.stdin.write(`${JSON.stringify({seq, type: 'request', command, arguments: args})}\n`);
    });

  return {
    request,
    async diagnostics(file) {
      const syntactic = await request<TsDiagnostic[]>('syntacticDiagnosticsSync', {file});
      const semantic = await request<TsDiagnostic[]>('semanticDiagnosticsSync', {file});
      return [...syntactic, ...semantic];
    },
    async stop() {
      if (running()) child.stdin.write(`${JSON.stringify({seq: ++seq, type: 'request', command: 'exit'})}\n`);
      const timeout = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timeout);
    },
  };
}
