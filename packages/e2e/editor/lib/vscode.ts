import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests} from '@vscode/test-electron';
import {TMP_DIR} from '../../fixtures/index.ts';
import {REPO_ROOT} from './vsix.ts';

// Newest stable at least 30 days old: the same age floor as npm packages.
export const VSCODE_VERSION = '1.137.0';
export const CRASH_DIR = join(TMP_DIR, 'vscode-crashes');
const CACHE_DIR = join(REPO_ROOT, '.vscode-test');
// A download takes minutes at most: an older lock was left by a killed run.
const STALE_LOCK_MS = 15 * 60_000;

interface CheckResult {
  name: string;
  error?: string; // the failed check's stack
}

type RunOptions = ({extension: string; vsix?: never} | {vsix: string; extension?: never}) & {
  // extension: the development extension folder; vsix: a packed file, installed into the fresh extensions folder
  workspace: string;
  suite: string; // a .cjs file whose `run()` calls harness.cjs `runChecks`
  args?: string[]; // more VS Code arguments, such as `--disable-extension <id>`
  data?: unknown; // JSON the suite reads from the file `MULTIFRONT_VSCODE_DATA` names
};

interface Display {
  value: string;
  stop(): void;
}

/** Runs `suite` in the pinned VS Code; returns what each check recorded. */
export async function runInVsCode({extension, vsix, workspace, suite, args = [], data}: RunOptions): Promise<CheckResult[]> {
  const vscodeExecutablePath = await vscodeExecutable();
  const display = await startDisplay();
  const temp = mkdtempSync(join(tmpdir(), 'multifront-vscode-'));
  const results = join(temp, 'results.json');
  const dataFile = join(temp, 'data.json');
  if (data !== undefined) writeFileSync(dataFile, JSON.stringify(data));
  const output: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  let checks: CheckResult[];
  try {
    if (vsix) installVsix(vscodeExecutablePath, vsix, temp);
    // VS Code runs a test suite only beside a development path: an empty one leaves the installed copy in charge.
    const development = extension ?? join(temp, 'no-development-extension');
    mkdirSync(development, {recursive: true});
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: development,
      extensionTestsPath: suite,
      // Fresh profile: a kept one restores the hot-exit backup of an earlier run's unsaved edit.
      launchArgs: [
        workspace,
        `--user-data-dir=${join(temp, 'user-data')}`,
        `--extensions-dir=${join(temp, 'extensions')}`,
        // Turns Crashpad on despite ~/.vscode/argv.json; dumps stay in temp.
        `--crash-reporter-directory=${join(temp, 'crashes')}`,
        ...args,
      ],
      // NODE_PATH from pnpm's bin shim would let the extension find the repo's packages.
      // Electron rejects the host's NODE_OPTIONS at startup; CI never sets it.
      extensionTestsEnv: {
        MULTIFRONT_VSCODE_RESULTS: results,
        ...(data !== undefined && {MULTIFRONT_VSCODE_DATA: dataFile}),
        NODE_PATH: undefined,
        NODE_OPTIONS: undefined,
        ...(display && {DISPLAY: display.value}),
      },
      stdout: stream,
      stderr: stream,
    });
    checks = JSON.parse(readFileSync(results, 'utf8')) as CheckResult[];
  } catch (err) {
    const notes = [
      await noted('leftover VS Code processes not awaited', () => leftoversGone(temp)),
      await noted('crash dump not kept', () => {
        const crashFolder = keepCrashDumps(temp);
        return crashFolder && `crash dump kept in ${crashFolder}`;
      }),
      await noted('temp folder not removed', () => rmSync(temp, {recursive: true, force: true, maxRetries: 5})),
    ].join('');
    throw new Error(`VS Code run failed: ${String(err)}${notes}\n${output.join('').slice(-20_000)}`, {cause: err});
  } finally {
    display?.stop();
  }
  await leftoversGone(temp);
  rmSync(temp, {recursive: true, force: true, maxRetries: 5});
  return checks;
}

/** A failed run's cleanup step: its error becomes a note, never replaces the run's own error. */
async function noted(failure: string, step: () => Promise<unknown> | unknown): Promise<string> {
  try {
    const note = await step();
    return typeof note === 'string' ? `\n${note}` : '';
  } catch (err) {
    return `\n${failure}: ${String(err)}`;
  }
}

// Crashpad runs in its own process group and outlives a crash, still writing the dump into `temp`.
async function leftoversGone(temp: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let pids = processesNaming(temp); pids.length > 0; pids = processesNaming(temp)) {
    if (Date.now() > deadline) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Each VS Code process names its profile or dump folder, both inside `temp`. */
function processesNaming(temp: string): number[] {
  if (process.platform === 'win32') return [];
  const list = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], {encoding: 'utf8'});
  return list
    .split('\n')
    .filter((line) => line.includes(temp))
    .map((line) => Number.parseInt(line, 10));
}

/** The pinned VS Code, downloaded once: test-electron's download has no lock, and specs run in parallel. */
async function vscodeExecutable(): Promise<string> {
  mkdirSync(CACHE_DIR, {recursive: true});
  const lock = join(CACHE_DIR, 'download.lock');
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() - lockTime(lock) > STALE_LOCK_MS) rmSync(lock, {recursive: true, force: true});
      else await sleep(500);
    }
  }
  try {
    return await downloadAndUnzipVSCode({version: VSCODE_VERSION, cachePath: CACHE_DIR});
  } finally {
    rmSync(lock, {recursive: true, force: true});
  }
}

/** Released between the failed mkdir and this read: as good as fresh. */
function lockTime(lock: string): number {
  try {
    return statSync(lock).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** As a user installs it: VS Code's own CLI, into the run's fresh profile. */
function installVsix(vscodeExecutablePath: string, vsix: string, temp: string): void {
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {reuseMachineInstall: true});
  const profile = [`--extensions-dir=${join(temp, 'extensions')}`, `--user-data-dir=${join(temp, 'user-data')}`];
  const result = spawnSync(cli!, [...cliArgs, '--install-extension', vsix, ...profile], {
    encoding: 'utf8',
    env: {...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined},
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `installing ${vsix} failed (${result.error?.message ?? `exit ${result.status}`}):\n${result.stdout}\n${result.stderr}`
    );
  }
}

function keepCrashDumps(temp: string): string | undefined {
  const crashes = join(temp, 'crashes');
  if (!existsSync(crashes)) return undefined;
  const dumps = readdirSync(crashes, {recursive: true, encoding: 'utf8'}).filter((name) => name.endsWith('.dmp'));
  if (dumps.length === 0) return undefined;
  const kept = join(CRASH_DIR, basename(temp));
  mkdirSync(kept, {recursive: true});
  for (const dump of dumps) cpSync(join(crashes, dump), join(kept, basename(dump)));
  return kept;
}

/** A headless Linux host has no display: start Xvfb on a free one. */
async function startDisplay(): Promise<Display | undefined> {
  if (process.platform !== 'linux' || process.env.DISPLAY) return undefined;
  const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const number = await new Promise<string>((resolve, reject) => {
    let text = '';
    xvfb.once('error', (err) => reject(new Error(`no display and Xvfb did not start (install xvfb): ${err.message}`)));
    xvfb.once('exit', (code) => reject(new Error(`Xvfb exited with code ${code} before it named a display`)));
    // -displayfd writes the display number and a newline once the server is ready.
    xvfb.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(text.trim());
    });
  });
  return {value: `:${number}`, stop: () => xvfb.kill()};
}
