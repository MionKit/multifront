// A throwaway verdaccio for packed workspace packages that depend on each other, as MionKit/mion runs it.
import {execFile, spawn} from 'node:child_process';
import {existsSync, openSync, readFileSync} from 'node:fs';
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {REPO_ROOT, freePort} from './app.ts';

const run = promisify(execFile);
const VERDACCIO = join(REPO_ROOT, 'node_modules', 'verdaccio', 'bin', 'verdaccio');
const CONFIG = join(import.meta.dirname, 'verdaccio.yaml');
const READY_TIMEOUT = 60_000;

export interface Registry {
  url: string;
  publish: (tarball: string) => Promise<void>;
  stop: () => Promise<void>;
}

export async function startRegistry(): Promise<Registry> {
  const dir = await mkdtemp(join(tmpdir(), 'mf-registry-'));
  await cp(CONFIG, join(dir, 'config.yaml'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  // Detached, its output in a file: the only place its startup errors can be read once the ping gives up.
  const log = join(dir, 'verdaccio.log');
  const child = spawn(process.execPath, [VERDACCIO, '--config', join(dir, 'config.yaml'), '--listen', `127.0.0.1:${port}`], {
    stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')],
    detached: true,
  });
  // A child a signal ended keeps `exitCode` null.
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const kill = () => {
    try {
      process.kill(-child.pid!);
    } catch {
      // Already gone.
    }
  };
  // A detached group outlives its parent: an interrupted run must not leave it listening.
  process.once('exit', kill);
  const stop = async () => {
    process.off('exit', kill);
    if (!exited()) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      kill();
      await gone;
    }
    await rm(dir, {recursive: true, force: true});
  };
  try {
    for (const deadline = Date.now() + READY_TIMEOUT; ;) {
      if (exited()) throw new Error(`verdaccio exited (${child.exitCode ?? child.signalCode})`);
      if ((await fetch(`${url}-/ping`).catch(() => undefined))?.ok) break;
      if (Date.now() > deadline) throw new Error(`verdaccio did not answer on ${url} within ${READY_TIMEOUT / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (err) {
    const output = existsSync(log) ? readFileSync(log, 'utf8').trim() : '';
    await stop();
    throw new Error(`${(err as Error).message}:\n${output || '(no output)'}`);
  }
  // npm publishes only with a token; any token does here. Its own file, so the user's npm config is never touched.
  const userconfig = join(dir, 'npmrc');
  await writeFile(userconfig, `//127.0.0.1:${port}/:_authToken=local\n`);
  const publish = async (tarball: string) => {
    await run('npm', ['publish', tarball, '--registry', url, '--userconfig', userconfig]);
  };
  return {url, publish, stop};
}
