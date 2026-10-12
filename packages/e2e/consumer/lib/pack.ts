import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {TARGETS} from '@multifront/core';
import type {Target} from '@multifront/core';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export interface ToolRun {
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

// Neither tool exports its `package.json`, so it is found the way Node walks `node_modules`.
function binOf(name: string, bin: string): string {
  const dir = require.resolve
    .paths(name)
    ?.map((modules) => join(modules, name))
    .find((path) => existsSync(join(path, 'package.json')));
  if (!dir) throw new Error(`${name} is not installed`);
  return join(dir, (require(join(dir, 'package.json')) as {bin: Record<string, string>}).bin[bin]!);
}

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
  return runTool(binOf('publint', 'publint'), [tarball, '--strict']);
}

// A CSS subpath has no types to resolve, so attw would call it NoResolution; no registry lookup for @types.
export function attw(tarball: string): Promise<ToolRun> {
  const args = [tarball, '--profile', 'esm-only', '--exclude-entrypoints', 'styles.css', '--no-definitely-typed'];
  return runTool(binOf('@arethetypeswrong/cli', 'attw'), [...args, '--no-color', '--no-emoji']);
}
