import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests} from '@vscode/test-electron';
import {beforeAll, expect, it} from 'vitest';
import {TMP_DIR} from '../../fixtures/index.ts';
import {REPO_ROOT} from './vsix.ts';

// Newest stable at least 30 days old: the same age floor as npm packages.
export const VSCODE_VERSION = '1.137.0';
export const CRASH_DIR = join(TMP_DIR, 'vscode-crashes');
const CACHE_DIR = join(REPO_ROOT, '.vscode-test');
const LOCK = join(CACHE_DIR, 'download.lock');
const FONTCONFIG_ROOT = join(TMP_DIR, 'vscode-fontconfig');
// Paths inside FONTCONFIG_ROOT: fontconfig prefixes every path with its sysroot.
const FONTCONFIG = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <cachedir>/cache</cachedir>
</fontconfig>
`;

/** A check of a suite .cjs file, as the spec reads it outside VS Code. */
export interface Check {
  name: string;
}

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
        ...(process.platform === 'linux' && {FONTCONFIG_SYSROOT: fontconfigRoot()}),
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

/** One test per check of `names`, from the results of one VS Code run that `start` makes. */
export function reportChecks(names: Check[], start: () => Promise<CheckResult[]>): void {
  let results: CheckResult[];

  // Long timeout: the first run downloads VS Code; later ones start it in seconds.
  beforeAll(async () => {
    results = await start();
  }, 900_000);

  it.each(names.map(({name}) => name))('%s', (name) => {
    const result = results.find((row) => row.name === name);
    // A missing result: the suite died before this check.
    expect(result, `${name} did not run`).toBeDefined();
    if (result?.error) throw new Error(result.error);
  });
}

/** The pinned VS Code, downloaded once: test-electron's download has no lock, and specs run in parallel. */
async function vscodeExecutable(): Promise<string> {
  mkdirSync(CACHE_DIR, {recursive: true});
  const token = `${process.pid} ${randomUUID()}`;
  while (!takeLock(token)) await sleep(500);
  try {
    return await downloadAndUnzipVSCode({version: VSCODE_VERSION, cachePath: CACHE_DIR});
  } finally {
    if (readLock(LOCK) === token) rmSync(LOCK, {force: true});
  }
}

/** The lock file holds `<pid> <uuid>`: a run killed mid-download leaves it, and a waiter retires it once that pid is gone. */
function takeLock(token: string): boolean {
  try {
    writeFileSync(LOCK, token, {flag: 'wx'});
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const held = readLock(LOCK);
  const owner = Number(held?.split(' ')[0]);
  // Empty: its owner is still writing it.
  if (!owner || isAlive(owner)) return false;
  const retired = `${LOCK}.${process.pid}`;
  try {
    renameSync(LOCK, retired);
  } catch {
    return false;
  }
  // Another waiter retired the same dead lock first and took a fresh one: put that one back.
  if (readLock(retired) !== held) {
    try {
      linkSync(retired, LOCK);
    } catch {}
  }
  rmSync(retired, {force: true});
  return false;
}

function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** As a user installs it: VS Code's own CLI, into the run's fresh profile. */
function installVsix(vscodeExecutablePath: string, vsix: string, temp: string): void {
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {reuseMachineInstall: true});
  const profile = [`--extensions-dir=${join(temp, 'extensions')}`, `--user-data-dir=${join(temp, 'user-data')}`];
  // A shell joins the arguments unquoted, and these paths may hold spaces.
  const quote = (arg: string) => (process.platform === 'win32' ? `"${arg}"` : arg);
  const result = spawnSync(quote(cli!), [...cliArgs, '--install-extension', vsix, ...profile].map(quote), {
    encoding: 'utf8',
    env: {...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined},
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `installing ${vsix} failed (${result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${result.status}`)}):\n${result.stdout}\n${result.stderr}`
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

/** Main process once crashed in pango's background FcInit parsing 64 host font configs; this root cuts that to one. */
function fontconfigRoot(): string {
  const config = join(FONTCONFIG_ROOT, 'etc', 'fonts', 'fonts.conf');
  mkdirSync(dirname(config), {recursive: true});
  mkdirSync(join(FONTCONFIG_ROOT, 'usr', 'share'), {recursive: true});
  try {
    symlinkSync('/usr/share/fonts', join(FONTCONFIG_ROOT, 'usr', 'share', 'fonts'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Parallel specs build it at once: a rename shows a reader the whole file or none.
  const part = `${config}.${randomUUID()}`;
  writeFileSync(part, FONTCONFIG);
  renameSync(part, config);
  // Cold cache: pango's thread scans every font file at startup; warm, it only stats the dirs.
  execFileSync('fc-cache', [], {env: {PATH: process.env.PATH, FONTCONFIG_SYSROOT: FONTCONFIG_ROOT}});
  return FONTCONFIG_ROOT;
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
