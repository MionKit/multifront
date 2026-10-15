import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import type {Finding} from '@multifront/core';
import {E2E_DIR} from './tsserver.ts';

export interface BinRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** A command's `--format json` document: findings and counts, plus the command's own data. */
export interface BinReport {
  findings: Finding[];
  errorCount: number;
  warningCount: number;
  [data: string]: unknown;
}

// The bin's JS entry, not the `.bin` shim (a `.cmd` file on Windows), with the package's `src/` under `source`.
export async function runBin(
  packageName: string,
  bin: string,
  cwd: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {}
): Promise<BinRun> {
  const dir = join(E2E_DIR, 'node_modules', packageName);
  const {bin: bins} = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {bin: Record<string, string>};
  try {
    const run = promisify(execFile)(process.execPath, ['--conditions=source', join(dir, bins[bin]!), ...args], {
      cwd,
      env: {...process.env, ...env},
    });
    const {stdout, stderr} = await run;
    return {code: 0, stdout, stderr};
  } catch (err) {
    const {code, stdout = '', stderr = ''} = err as {code?: number | string; stdout?: string; stderr?: string};
    if (typeof code !== 'number') throw err;
    return {code, stdout, stderr};
  }
}

export function runMfTsc(cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<BinRun> {
  return runBin('@multifront/language-tools', 'mf-tsc', cwd, args, env);
}
