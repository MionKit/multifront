/**
 * Vite in a fresh Node process: plugin-vue's descriptor cache lives at its module level, so only a new process
 * starts it empty. Run as a script, this file is the child of `runFreshDevServer()`.
 */
import {execFile, spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {APP_CONFIG_LOADER, withDevServer} from './build.ts';

type FreshStep = {env: 'client' | 'ssr'; request: string} | {edit: {file: string; from: string; to: string}} | {restart: true};

const VITE_BIN = join(import.meta.dirname, '..', '..', '..', '..', 'node_modules', 'vite', 'bin', 'vite.js');
// Node itself loads the app's `vite.config.ts`: `source` makes it pick `@multifront/vite`'s `src/`.
const SOURCE_CONDITION = '--conditions=source';
export const execNode = promisify(execFile);
// Both below Vitest's 60 s timeouts, so the case fails with our message instead of a bare timeout.
const OUTPUT_TIMEOUT_MS = 30_000;
// Vite's SIGTERM handler awaits `server.close()`, which waits for the dep scan and bundling with no bound.
export const STOP_GRACE_MS = 5_000;

function startNode(root: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SOURCE_CONDITION, ...args], {cwd: root, env: {...process.env, NO_COLOR: '1', ...env}});
  let output = '';
  const waiters = new Set<() => void>();
  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    for (const check of waiters) check();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return {
    output: () => output,
    waitForOutput(pattern: RegExp, count = 1, timeoutMs = OUTPUT_TIMEOUT_MS): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no ${count} × ${pattern} after ${timeoutMs} ms:\n${output}`));
        }, timeoutMs);
        const check = () => {
          if ((output.match(new RegExp(pattern, 'g')) ?? []).length < count) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(output);
        };
        waiters.add(check);
        void exited.then(() => {
          if (!waiters.delete(check)) return;
          clearTimeout(timer);
          reject(new Error(`process exited before ${pattern}:\n${output}`));
        });
        check();
      });
    },
    async finished(): Promise<string> {
      const code = await exited;
      if (code !== 0) throw new Error(`exited with ${code}:\n${output}`);
      return output;
    },
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

export function startViteCli(root: string, args: string[], env: NodeJS.ProcessEnv) {
  return startNode(root, [VITE_BIN, '--configLoader', APP_CONFIG_LOADER, ...args], env);
}

/** `url` resolves once the app's `server.ts` listens. */
export function startSsrServer(root: string) {
  const server = startNode(root, ['server.ts'], {NODE_ENV: 'development'});
  const url = server.waitForOutput(/ssr server: \S+/).then((output) => /ssr server: (\S+)/.exec(output)![1]!);
  return {...server, url};
}

/** Runs `steps` on one dev server of `root`, watcher off, in a fresh process; one code per request step. */
export async function runFreshDevServer(...args: Parameters<typeof runSteps>): Promise<string[]> {
  // Killed before Vitest's 60 s test timeout gives up on it.
  const {stdout} = await execNode(process.execPath, [SOURCE_CONDITION, import.meta.filename, JSON.stringify(args)], {
    timeout: 50_000,
  });
  return JSON.parse(stdout) as string[];
}

// No watcher events: a hot update would refresh plugin-vue's cache behind the case's back.
const NO_WATCH = {server: {watch: {ignored: () => true}}};

async function runSteps(root: string, steps: FreshStep[]): Promise<string[]> {
  return withDevServer(root, NO_WATCH, async (server) => {
    const codes: string[] = [];
    for (const step of steps) {
      if ('restart' in step) await server.restart();
      else if ('edit' in step) {
        const {file, from, to} = step.edit;
        await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
      } else codes.push((await server.environments[step.env].transformRequest(step.request))?.code ?? '');
    }
    return codes;
  });
}

if (import.meta.main) {
  process.stdout.write(JSON.stringify(await runSteps(...(JSON.parse(process.argv[2]!) as Parameters<typeof runSteps>))));
}
