import {existsSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {loadConfigFromFile, normalizePath} from 'vite';
import type {Target} from '@multifront/core';
import type {LibraryOptions, LibraryResult} from '../types.ts';
import {buildLibrary} from './build.ts';

const CONFIG_FILES = ['multifront.config.ts', 'multifront.config.js', 'multifront.config.mjs'];

// A config may throw anything; Vite rethrows it unchanged.
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Native: Node resolves the config's own imports, so `--conditions=source` reaches them; the bundler resolves with `node` only.
async function loadConfig(root: string): Promise<LibraryOptions> {
  const file = CONFIG_FILES.map((name) => join(root, name)).find((path) => existsSync(path));
  if (file === undefined) return {};
  try {
    const loaded = await loadConfigFromFile({command: 'build', mode: 'production'}, file, root, 'silent', undefined, 'native');
    return (loaded?.config ?? {}) as LibraryOptions;
  } catch (err) {
    throw new Error(`cannot load ${file}: ${messageOf(err)}`, {cause: err});
  }
}

function summary({target, files, outDir, packageName, skipped}: LibraryResult): string {
  const shown = normalizePath(relative(process.cwd(), outDir)) || '.';
  const line = `${target}: ${files.length} files in ${shown} (${packageName})`;
  return skipped.length > 0 ? `${line}, skipped ${skipped.join(', ')}` : line;
}

/** `mf-build [--root <dir>] [--framework <name>]… [--out-dir <dir>] [--no-dts]`; resolves with the exit code. */
export async function runMfBuild(args: string[]): Promise<number> {
  try {
    const {values} = parseArgs({
      args,
      options: {
        root: {type: 'string'},
        framework: {type: 'string', multiple: true},
        'out-dir': {type: 'string'},
        'no-dts': {type: 'boolean'},
      },
    });
    const root = resolve(values.root ?? '.');
    const options: LibraryOptions = {...(await loadConfig(root)), root};
    if (values.framework) options.frameworks = values.framework as Target[];
    if (values['out-dir'] !== undefined) options.outDir = values['out-dir'];
    if (values['no-dts']) options.dts = false;
    for (const result of await buildLibrary(options)) process.stdout.write(`${summary(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`mf-build: ${messageOf(err)}\n`);
    return 1;
  }
}
