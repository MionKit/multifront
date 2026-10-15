import {existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runCommand} from '@multifront/core';
import type {CommandResult, CommandSpec, CommandValues, Target} from '@multifront/core';
import {createLogger, normalizePath} from 'vite';
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

// A config may throw anything.
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Natively, as Vite's `native` loader does: Node resolves the config's imports, honouring `--conditions=source`. */
async function importConfig(file: string): Promise<unknown> {
  // Top-level await makes the graph async: Node 26.12 prints a trace when a sync-run module throws a non-Error.
  const wrapper = `import * as config from ${JSON.stringify(pathToFileURL(file).href)};\nawait 0;\nexport {config};\n`;
  const {config} = (await import(`data:text/javascript,${encodeURIComponent(wrapper)}`)) as {config: {default?: unknown}};
  return config.default;
}

async function loadConfig(root: string): Promise<LibraryOptions> {
  const file = CONFIG_FILES.map((name) => join(root, name)).find((path) => existsSync(path));
  if (file === undefined) return {};
  try {
    const exported = await importConfig(file);
    const config: unknown = await (typeof exported === 'function' ? exported({command: 'build', mode: 'production'}) : exported);
    if (Object.prototype.toString.call(config) !== '[object Object]') throw new Error('config must export or return an object.');
    return config as LibraryOptions;
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
  // Drops only Vite's `✗ Build failed` line: the findings say what failed.
  const logger = config.vite?.customLogger ?? createLogger(config.vite?.logLevel ?? 'warn');
  const error: typeof logger.error = (message, logOptions) => {
    if (!message.includes('Build failed in')) logger.error(message, logOptions);
  };
  // Through the prototype, `hasWarned` stays the one the logger's own `warn` sets.
  options.vite = {...config.vite, customLogger: Object.assign(Object.create(logger) as typeof logger, {error})};
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
