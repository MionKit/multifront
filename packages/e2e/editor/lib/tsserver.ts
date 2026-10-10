import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import type * as ts from 'typescript';

export type TsDiagnostic = ts.server.protocol.Diagnostic;
export type TsLocation = ts.server.protocol.Location;

export interface Tsserver {
  request<Body = unknown>(command: string, args?: object): Promise<Body>;
  diagnostics(file: string): Promise<TsDiagnostic[]>; // syntactic, then semantic
  stop(): Promise<void>;
}

interface TsserverOptions {
  cwd: string;
  plugins: string[]; // global plugins, found as installed in packages/e2e/node_modules
}

const TSSERVER = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
const E2E_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HEADER = 'Content-Length: ';

/** 1-based line and offset of `needle` (plus `shift` characters) in `source`, as tsserver counts. */
export function locate(source: string, needle: string, shift = 0): TsLocation {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`${needle} not found`);
  const before = source.slice(0, index + shift).split('\n');
  return {line: before.length, offset: before.at(-1)!.length + 1};
}

/** The offset in `source` of a tsserver location. */
export function offsetAt(source: string, {line, offset}: TsLocation): number {
  const lines = source.split('\n').slice(0, line - 1);
  return lines.reduce((sum, text) => sum + text.length + 1, 0) + offset - 1;
}

/** The real tsserver over its stdio protocol; plugins run from source, as the workspace links them. */
export function startTsserver({cwd, plugins}: TsserverOptions): Tsserver {
  const args = ['--conditions=source', TSSERVER, '--disableAutomaticTypingAcquisition'];
  if (plugins.length > 0) args.push('--globalPlugins', plugins.join(','), '--pluginProbeLocations', E2E_DIR);
  const child = spawn(process.execPath, args, {cwd, stdio: ['pipe', 'pipe', 'inherit']});
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
