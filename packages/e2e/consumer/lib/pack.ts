import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {TARGETS} from '@multifront/core';
import type {Target} from '@multifront/core';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

interface ToolRun {
  code: number;
  output: string;
}

/** One real `pnpm pack` per target folder of a `buildLibrary()` out dir; the tarballs land in `outDir`. */
export async function packLibrary(outDir: string): Promise<Partial<Record<Target, string>>> {
  const tarballs: Partial<Record<Target, string>> = {};
  for (const target of TARGETS) {
    const dir = join(outDir, target);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const {stdout} = await run('pnpm', ['pack', '--pack-destination', outDir, '--json'], {cwd: dir});
    tarballs[target] = (JSON.parse(stdout) as {filename: string}).filename;
  }
  return tarballs;
}

/** Every entry of a tarball, from real `tar -t`. */
export async function tarFiles(tarball: string): Promise<string[]> {
  const {stdout} = await run('tar', ['-tzf', tarball]);
  return stdout.split('\n').filter(Boolean).sort();
}

// publint exports no `package.json`; its bin sits beside its main file.
const PUBLINT = join(dirname(require.resolve('publint')), 'cli.js');
const ATTW = join(dirname(require.resolve('@arethetypeswrong/cli/package.json')), 'dist', 'index.js');

async function runTool(file: string, args: string[]): Promise<ToolRun> {
  try {
    const {stdout, stderr} = await run(process.execPath, [file, ...args], {env: {...process.env, NO_COLOR: '1'}});
    return {code: 0, output: `${stdout}${stderr}`};
  } catch (err) {
    const {code, stdout = '', stderr = ''} = err as {code?: number; stdout?: string; stderr?: string};
    return {code: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` || String(err)};
  }
}

/** Real publint on the tarball itself; warnings fail too. */
export function publint(tarball: string): Promise<ToolRun> {
  return runTool(PUBLINT, [tarball, '--strict']);
}

// A CSS subpath has no types to resolve, so attw would call it NoResolution; no registry lookup for @types.
export function attw(tarball: string): Promise<ToolRun> {
  return runTool(ATTW, [tarball, '--profile', 'esm-only', '--exclude-entrypoints', 'styles.css', '--no-definitely-typed']);
}
