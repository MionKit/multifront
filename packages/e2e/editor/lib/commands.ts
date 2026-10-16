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

interface BinOptions {
  source?: boolean; // the package's `src/` (default), else its built `dist/`
  env?: NodeJS.ProcessEnv; // over this process's own
}

/** A command's `--format json` document. */
export type BinReport<Data> = {findings: Finding[]; errorCount: number; warningCount: number} & Data;

// Runs the bin's JS entry, not the `.bin` shim: Windows shims are `.cmd` files that need a shell.
export async function runBin(
  packageName: string,
  bin: string,
  cwd: string,
  args: string[] = [],
  {source = true, env}: BinOptions = {}
): Promise<BinRun> {
  const dir = join(E2E_DIR, 'node_modules', packageName);
  const {bin: bins} = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {bin: Record<string, string>};
  const node = source ? ['--conditions=source'] : [];
  try {
    const {stdout, stderr} = await promisify(execFile)(process.execPath, [...node, join(dir, bins[bin]!), ...args], {
      cwd,
      env: {...process.env, ...env},
    });
    return {code: 0, stdout, stderr};
  } catch (err) {
    const {code, stdout = '', stderr = ''} = err as {code?: number | string; stdout?: string; stderr?: string};
    if (typeof code !== 'number') throw err;
    return {code, stdout, stderr};
  }
}

export function runMfTsc(cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<BinRun> {
  return runBin('@multifront/language-tools', 'mf-tsc', cwd, args, {env});
}

export function runMfFmt(cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<BinRun> {
  return runBin('@multifront/language-tools', 'mf-fmt', cwd, args, {env});
}

export function runMfLint(cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<BinRun> {
  return runBin('@multifront/language-tools', 'mf-lint', cwd, args, {env});
}
