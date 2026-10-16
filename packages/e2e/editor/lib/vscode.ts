import {execFileSync, spawn} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {runTests} from '@vscode/test-electron';
import {TMP_DIR} from '../../fixtures/index.ts';
import {REPO_ROOT} from './vsix.ts';

// Newest stable at least 30 days old: the same age floor as npm packages.
export const VSCODE_VERSION = '1.137.0';
export const CRASH_DIR = join(TMP_DIR, 'vscode-crashes');

interface CheckResult {
  name: string;
  error?: string; // the failed check's stack
}

interface RunOptions {
  extension: string; // the development extension folder
  workspace: string;
  suite: string; // a .cjs file whose `run()` calls harness.cjs `runChecks`
  args?: string[]; // more VS Code arguments, such as `--disable-extension <id>`
}

interface Display {
  value: string;
  stop(): void;
}

/** Runs `suite` in the pinned VS Code; returns what each check recorded. */
export async function runInVsCode({extension, workspace, suite, args = []}: RunOptions): Promise<CheckResult[]> {
  const display = await startDisplay();
  const temp = mkdtempSync(join(tmpdir(), 'multifront-vscode-'));
  const results = join(temp, 'results.json');
  const output: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  let checks: CheckResult[];
  try {
    await runTests({
      version: VSCODE_VERSION,
      cachePath: join(REPO_ROOT, '.vscode-test'),
      extensionDevelopmentPath: extension,
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
        NODE_PATH: undefined,
        NODE_OPTIONS: undefined,
        ...(display && {DISPLAY: display.value}),
      },
      stdout: stream,
      stderr: stream,
    });
    checks = JSON.parse(readFileSync(results, 'utf8')) as CheckResult[];
  } catch (err) {
    const notes = await cleanUp(temp, true);
    throw new Error(`VS Code run failed: ${String(err)}${notes}\n${output.join('').slice(-20_000)}`, {cause: err});
  } finally {
    display?.stop();
  }
  await cleanUp(temp, false);
  return checks;
}

/** Deletes `temp` once nothing of the run writes into it, keeping a failed run's dumps; returns notes for its error. */
async function cleanUp(temp: string, failed: boolean): Promise<string> {
  let notes = '';
  try {
    await leftoversGone(temp);
  } catch (waitErr) {
    if (!failed) throw waitErr;
    notes += `\nleftover VS Code processes not awaited: ${String(waitErr)}`;
  }
  if (failed) {
    try {
      const crashFolder = keepCrashDumps(temp);
      if (crashFolder) notes += `\ncrash dump kept in ${crashFolder}`;
    } catch (copyErr) {
      notes += `\ncrash dump not kept: ${String(copyErr)}`;
    }
  }
  try {
    rmSync(temp, {recursive: true, force: true, maxRetries: 5});
  } catch (rmErr) {
    // A failed run's own error matters more than its leftover folder.
    if (!failed) throw rmErr;
    notes += `\ntemp folder not removed: ${String(rmErr)}`;
  }
  return notes;
}

// Crashpad runs in its own process group and outlives a crash, still writing the dump into `temp`.
async function leftoversGone(temp: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let pids = processesNaming(temp); pids.length > 0; pids = processesNaming(temp)) {
    if (Date.now() > deadline) {
      for (const pid of pids) killIfAlive(pid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    // ESRCH: it exited since `ps` listed it.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/** Every process with `temp` in its command line: each VS Code process names its profile or dump folder. */
function processesNaming(temp: string): number[] {
  if (process.platform === 'win32') return [];
  const list = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], {encoding: 'utf8'});
  return list
    .split('\n')
    .filter((line) => line.includes(temp))
    .map((line) => Number.parseInt(line, 10));
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
