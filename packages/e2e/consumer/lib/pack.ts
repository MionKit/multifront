import {execFile} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {TARGETS, scopeId} from '@multifront/core';
import type {Target} from '@multifront/core';
import {buildLibrary} from '@multifront/vite';
import {LIBRARY_DIR} from '../../fixtures/index.ts';
import {buildFixtureLibrary} from '../../build/lib/library.ts';

const run = promisify(execFile);

type Tarballs = Partial<Record<Target, string>>;
const require = createRequire(import.meta.url);

export interface ToolRun {
  code: number;
  output: string;
}

/** Real `pnpm pack` per framework folder of a `buildLibrary()` out dir. */
export async function packLibrary(outDir: string): Promise<Tarballs> {
  const tarballs: Tarballs = {};
  for (const target of TARGETS) {
    const dir = join(outDir, target);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const {stdout} = await run('pnpm', ['pack', '--pack-destination', outDir, '--json'], {cwd: dir});
    tarballs[target] = (JSON.parse(stdout) as {filename: string}).filename;
  }
  return tarballs;
}

const TARBALLS_FILE = 'tarballs.json';

/** The tarballs `pnpm devx consumer-pack <dir>` wrote (CI hands them over), else a fresh build and pack. */
export async function fixtureTarballs(
  dir = process.env.MULTIFRONT_CONSUMER_TARBALLS
): Promise<{tarballs: Tarballs; remove: () => Promise<void>}> {
  if (dir) {
    const list = join(resolve(dir), TARBALLS_FILE);
    if (!existsSync(list)) throw new Error(`${dir} has no ${TARBALLS_FILE}: run pnpm devx consumer-pack ${dir}`);
    const names = JSON.parse(readFileSync(list, 'utf8')) as Tarballs;
    const tarballs = Object.fromEntries(Object.entries(names).map(([target, name]) => [target, join(resolve(dir), name!)]));
    return {tarballs, remove: async () => {}};
  }
  const library = await buildFixtureLibrary();
  try {
    return {tarballs: await packLibrary(library.outDir), remove: library.remove};
  } catch (err) {
    await library.remove();
    throw err;
  }
}

/** The `data-v-<id>` attribute every target stamps for a library fixture file (path relative to its `src`). */
export function scopeAttribute(file: string): string {
  return `data-v-${scopeId(`src/${file}`, readFileSync(join(LIBRARY_DIR, 'src', file), 'utf8'), true)}`;
}

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

/** `--strict`: warnings fail too. */
export function publint(tarball: string): Promise<ToolRun> {
  return runTool(PUBLINT, [tarball, '--strict']);
}

// A CSS subpath has no types to resolve, so attw would call it NoResolution; no registry lookup for @types.
export function attw(tarball: string): Promise<ToolRun> {
  return runTool(ATTW, [tarball, '--profile', 'esm-only', '--exclude-entrypoints', 'styles.css', '--no-definitely-typed']);
}

// Entry of `pnpm devx consumer-pack <dir>`, run once in CI.
if (import.meta.main) {
  const dir = process.argv[2]!;
  await buildLibrary({root: LIBRARY_DIR, outDir: dir, vite: {logLevel: 'silent'}});
  const tarballs = await packLibrary(dir);
  const names = Object.fromEntries(Object.entries(tarballs).map(([target, file]) => [target, basename(file)]));
  await writeFile(join(dir, TARBALLS_FILE), `${JSON.stringify(names, null, 2)}\n`);
}
