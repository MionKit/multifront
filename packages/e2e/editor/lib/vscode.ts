import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {runTests} from '@vscode/test-electron';
import {REPO_ROOT} from './vsix.ts';

// The newest stable at least 30 days old: a downloaded build gets the same age floor as npm packages.
export const VSCODE_VERSION = '1.137.0';

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

/** Runs `suite` in the pinned VS Code with fresh user data and extensions folders; returns what each check recorded. */
export async function runInVsCode({extension, workspace, suite, args = []}: RunOptions): Promise<CheckResult[]> {
  const display = await startDisplay();
  const temp = mkdtempSync(join(tmpdir(), 'multifront-vscode-'));
  const results = join(temp, 'results.json');
  const output: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => output.push(chunk.toString()));
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
        ...args,
      ],
      extensionTestsEnv: {MULTIFRONT_VSCODE_RESULTS: results, ...(display && {DISPLAY: display.value})},
      stdout: stream,
      stderr: stream,
    });
    return JSON.parse(readFileSync(results, 'utf8')) as CheckResult[];
  } catch (err) {
    throw new Error(`VS Code run failed: ${String(err)}\n${output.join('').slice(-20_000)}`, {cause: err});
  } finally {
    display?.stop();
    rmSync(temp, {recursive: true, force: true});
  }
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
