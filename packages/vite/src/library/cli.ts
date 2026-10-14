import {existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {runCommand} from '@multifront/core';
import type {CommandResult, CommandSpec, CommandValues, Target} from '@multifront/core';
import {createLogger, loadConfigFromFile, mergeConfig, normalizePath} from 'vite';
import type {LibraryOptions, LibraryResult} from '../types.ts';
import {buildLibrary} from './build.ts';
import {LibraryError} from './errors.ts';

const CONFIG_FILES = ['multifront.config.ts', 'multifront.config.js', 'multifront.config.mjs'];

const MF_BUILD: CommandSpec = {
  name: 'mf-build',
  summary: [
    'Builds the .ucf components of a library into one package per framework.',
    'Reads multifront.config.ts (or .js, .mjs) in the root; options win over it.',
  ],
  options: {
    root: {type: 'string', value: '<folder>', description: 'the library folder (default: the current folder)'},
    framework: {
      type: 'string',
      multiple: true,
      value: '<name>',
      description: 'build only this framework: vue, react or svelte; repeat for more',
    },
    'out-dir': {type: 'string', value: '<folder>', description: 'where the packages go, relative to the root (default: dist)'},
    'no-dts': {type: 'boolean', description: 'write no .d.ts files'},
  },
  example: 'mf-build --framework react --format json',
};

// A config may throw anything; Vite rethrows it unchanged.
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `native`: Node resolves the config's imports, honouring `--conditions=source`; the bundler resolves with `node` only.
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

function shownDir(dir: string): string {
  return normalizePath(relative(process.cwd(), dir)) || '.';
}

function builtSummary(results: LibraryResult[]): string {
  const packages = results.map(({target, files, skipped}) => {
    const line = `${target} ${files.length} files`;
    return skipped.length > 0 ? `${line} (skipped ${skipped.join(', ')})` : line;
  });
  const count = results.length === 1 ? '1 package' : `${results.length} packages`;
  return `built ${count} in ${shownDir(dirname(results[0]!.outDir))}: ${packages.join(', ')}`;
}

async function build(values: CommandValues): Promise<CommandResult> {
  const root = resolve((values.root as string | undefined) ?? '.');
  const config = await loadConfig(root);
  const options: LibraryOptions = {...config, root};
  if (values.framework) options.frameworks = values.framework as Target[];
  if (values['out-dir'] !== undefined) options.outDir = values['out-dir'] as string;
  if (values['no-dts']) options.dts = false;
  // Vite's `✗ Build failed` goes: the findings say what failed. Its warnings stay on stderr.
  const customLogger = createLogger(config.vite?.logLevel ?? 'warn');
  customLogger.error = () => {};
  options.vite = mergeConfig(config.vite ?? {}, {customLogger});
  try {
    const results = await buildLibrary(options);
    const packages = results.map(({target, packageName, outDir, files, skipped}) => {
      return {framework: target, name: packageName, outDir: shownDir(outDir), files: files.length, skipped};
    });
    return {findings: [], summary: builtSummary(results), data: {packages}};
  } catch (err) {
    if (!(err instanceof LibraryError)) throw err;
    const errors = err.findings.length === 1 ? '1 error' : `${err.findings.length} errors`;
    const framework = err.findings.find((finding) => finding.framework)?.framework;
    return {findings: err.findings, summary: `${errors} in the ${framework} build`, data: {packages: []}};
  }
}

export function runMfBuild(args: string[]): Promise<number> {
  return runCommand(MF_BUILD, args, build);
}
