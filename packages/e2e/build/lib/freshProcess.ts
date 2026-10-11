/**
 * Vite in a fresh Node process: plugin-vue's descriptor cache lives at its module level, so only a new process
 * starts it empty. Run as a script, this file is the child of `runFreshDevServer()`.
 */
import {spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'vite';
import {APP_CONFIG_LOADER, withNodeEnv} from './build.ts';

export type FreshStep =
  | {env: 'client' | 'ssr'; request: string}
  | {edit: {file: string; from: string; to: string}}
  | {restart: true};

const VITE_BIN = join(import.meta.dirname, '..', '..', '..', '..', 'node_modules', 'vite', 'bin', 'vite.js');

function nodeProcess(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  // Node itself loads the app's `vite.config.ts`: `source` makes it pick `@multifront/vite`'s `src/`.
  return spawn(process.execPath, ['--conditions=source', script, ...args], {cwd, env: {...process.env, NO_COLOR: '1', ...env}});
}

/** The `vite` CLI in `root`; `stop()` kills it. */
export function startViteCli(root: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = nodeProcess(VITE_BIN, ['--configLoader', APP_CONFIG_LOADER, ...args], root, env);
  let output = '';
  const waiters = new Set<() => void>();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    for (const check of waiters) check();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return {
    output: () => output,
    /** Resolves with the output once `pattern` matched `count` times. */
    waitForOutput(pattern: RegExp, count = 1): Promise<string> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if ((output.match(new RegExp(pattern, 'g')) ?? []).length < count) return;
          waiters.delete(check);
          resolve(output);
        };
        waiters.add(check);
        void exited.then(() => waiters.has(check) && reject(new Error(`vite exited before ${pattern}:\n${output}`)));
        check();
      });
    },
    async stop(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

/** Runs `steps` on one dev server of `root` in a fresh process; one code per request step, in order. */
export async function runFreshDevServer(root: string, steps: FreshStep[], {watch = true} = {}): Promise<string[]> {
  const child = nodeProcess(import.meta.filename, [JSON.stringify({root, steps, watch})], root, {});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`fresh dev server failed (${code}):\n${stderr}${stdout}`);
  return JSON.parse(stdout) as string[];
}

async function runSteps(root: string, steps: FreshStep[], watch: boolean): Promise<string[]> {
  return withNodeEnv('development', async () => {
    const server = await createServer({
      root,
      logLevel: 'silent',
      configLoader: APP_CONFIG_LOADER,
      cacheDir: join(root, '.vite'),
      // `null` turns the watcher off; Vite's `mergeConfig` would drop it.
      server: {middlewareMode: true, ws: false, watch: watch ? {} : null},
      optimizeDeps: {noDiscovery: true},
    });
    const codes: string[] = [];
    try {
      for (const step of steps) {
        if ('restart' in step) await server.restart();
        else if ('edit' in step) {
          const {file, from, to} = step.edit;
          await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
        } else codes.push((await server.environments[step.env].transformRequest(step.request))?.code ?? '');
      }
    } finally {
      await server.close();
    }
    return codes;
  });
}

if (import.meta.main) {
  const {root, steps, watch} = JSON.parse(process.argv[2]!) as {root: string; steps: FreshStep[]; watch: boolean};
  process.stdout.write(JSON.stringify(await runSteps(root, steps, watch)));
}
