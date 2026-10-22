/** `mf-lint`: each block's own text as a temporary file, linted by the project's oxlint, positions mapped back (spec 6.1). */
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, parse, resolve} from 'node:path';
import {promisify, stripVTControlCharacters} from 'node:util';
import {findingOf, locate, moduleName, rootRelativePath, runCommand, splitBlocks} from '@multifront/core';
import type {
  Block,
  CommandResult,
  CommandSpec,
  CommandValues,
  DiagnosticCode,
  Finding,
  SplitResult,
  Target,
} from '@multifront/core';
import {blockFile} from '../blocks/blockFile.ts';
import {counted, isIgnored, nearestFile, parseJsonc, problems, resolveInProject, slashed, frontFiles} from '../files.ts';
import type {FrontLintDiagnostic} from '../types.ts';

const MF_LINT: CommandSpec = {
  name: 'mf-lint',
  summary: ["Lints each block of .front files with oxlint and the project's .oxlintrc.json."],
  paths: 'Paths are .front files or folders; none lints every .front file under the current folder.',
  options: {'deny-warnings': {type: 'boolean', description: 'exit 1 on warnings too'}},
  example: 'mf-lint src/Card.front --format json',
};

const CONFIG_NAMES = ['.oxlintrc.json', '.oxlintrc.jsonc'];
const WRAPPER = '.oxlintrc.json';

interface OxlintDiagnostic extends Pick<FrontLintDiagnostic, 'message' | 'severity' | 'url' | 'help'> {
  code?: string; // none when the block does not parse
  filename: string;
  labels: {span: {offset: number; length: number}}[];
}

interface Written {
  split: SplitResult;
  block: Block;
  bytes: Buffer;
}

/** The project's own oxlint bin; its `exports` leave the bin out, its `package.json` names it. */
function oxlintBin(root: string): string {
  const missing = `oxlint is not installed in ${root}; add it to devDependencies`;
  const manifest = resolveInProject(root, 'oxlint/package.json', missing).path;
  const {bin} = JSON.parse(readFileSync(manifest, 'utf8')) as {bin: {oxlint: string}};
  return join(dirname(manifest), bin.oxlint);
}

const lintConfig = (fileName: string) => nearestFile(dirname(fileName), CONFIG_NAMES);

// A config that does not parse ignores nothing: oxlint's own run then names the error.
function ignorePatterns(config: string, root: string): string[] {
  try {
    const {ignorePatterns: patterns} = parseJsonc(config, root) as {ignorePatterns?: unknown};
    return Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === 'string') : [];
  } catch {
    return [];
  }
}

function ignoringConfig(fileName: string, root: string): string | undefined {
  const config = lintConfig(fileName);
  return config && isIgnored({file: config, ignorePatterns: ignorePatterns(config, root)}, fileName) ? config : undefined;
}

// oxlint prints a bad config on stdout as a miette report, colored under `FORCE_COLOR` or a Windows console; spec 8.1 wants one plain line.
function oxlintFailure(stdout: string, stderr: string, root: string, config: string | undefined): Error {
  const lines = stripVTControlCharacters(stderr.trim() || stdout.trim())
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[x×|│]\s)?/, '').trim())
    .filter(Boolean);
  const message = lines.join(' ');
  return new Error(`oxlint: ${config ? message.replaceAll(config, rootRelativePath(root, config)) : message}`);
}

async function runOxlint(bin: string, cwd: string, root: string, config: string | undefined): Promise<OxlintDiagnostic[]> {
  const args = [bin, '-c', WRAPPER, '-f', 'json', '.'];
  let output: {stdout: string; stderr: string};
  try {
    output = await promisify(execFile)(process.execPath, args, {cwd, maxBuffer: Infinity, encoding: 'utf8'});
  } catch (err) {
    const {code, stdout = '', stderr = ''} = err as {code?: number | string; stdout?: string; stderr?: string};
    if (code !== 1) throw oxlintFailure(stdout || String(err), stderr, root, config);
    output = {stdout, stderr};
  }
  try {
    const {diagnostics} = JSON.parse(output.stdout) as {diagnostics?: OxlintDiagnostic[]};
    if (Array.isArray(diagnostics)) return diagnostics;
  } catch {
    // Not its JSON report: a bad config exits 1 with a miette report instead.
  }
  throw oxlintFailure(output.stdout, output.stderr, root, config);
}

// Without a config the path only has to be unique: the whole path, its drive or share as the first folder.
function writtenPath(fileName: string, config: string | undefined): string {
  if (config) return rootRelativePath(dirname(config), fileName);
  const {root} = parse(fileName);
  return slashed(join(root.replace(/[^A-Za-z0-9]/g, ''), fileName.slice(root.length)));
}

// A literal path as an oxlint `overrides` glob: `[slug]` would be a character class, `Card.tsx` any folder's.
const literalGlob = (path: string) => `./${path.replace(/[*?[\]{}]/g, '[$&]')}`;

async function lintGroup(bin: string, config: string | undefined, splits: SplitResult[], root: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mf-lint-'));
  try {
    const written = new Map<string, Written>();
    const overrides: {files: string[]; globals: Record<string, 'readonly'>}[] = [];
    for (const split of splits) {
      // Relative to the config's folder, where oxlint anchors the `overrides` globs of the config it extends.
      const path = writtenPath(resolve(root, split.filename), config);
      const files: string[] = [];
      for (const block of split.blocks.filter(({type}) => type !== 'style')) {
        const file = slashed(blockFile(path, block));
        await mkdir(dirname(join(dir, file)), {recursive: true});
        await writeFile(join(dir, file), block.content);
        written.set(file, {split, block, bytes: Buffer.from(block.content)});
        files.push(literalGlob(file));
      }
      const modules = split.styles.flatMap((style) => moduleName(style) ?? []).filter((name) => name !== '$style');
      if (files.length > 0 && modules.length > 0) {
        overrides.push({files, globals: Object.fromEntries(modules.map((name) => [name, 'readonly' as const]))});
      }
    }
    const wrapper = {...(config && {extends: [config]}), globals: {$style: 'readonly'}, overrides};
    await writeFile(join(dir, WRAPPER), JSON.stringify(wrapper));
    return (await runOxlint(bin, dir, root, config)).map((diagnostic): FrontLintDiagnostic => {
      const hit = written.get(slashed(diagnostic.filename));
      if (!hit) throw new Error(`oxlint reported ${diagnostic.filename}, which mf-lint did not write`);
      const {split, block, bytes} = hit;
      // oxlint spans count UTF-8 bytes; no label: the block's opening tag.
      const at = (offset: number) => block.contentStart + bytes.subarray(0, offset).toString().length;
      const [label] = diagnostic.labels;
      const [start, end] = label
        ? [at(label.span.offset), at(label.span.offset + label.span.length)]
        : [block.start, block.contentStart];
      const {message, code, severity, url, help} = diagnostic;
      return {
        file: split.filename,
        start,
        end,
        block: block.type as Target,
        code: code ?? ('lint-parse-error' satisfies DiagnosticCode),
        message,
        severity,
        ...(url && {url}),
        ...(help && {help}),
      };
    });
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

/** One oxlint run per nearest `.oxlintrc.json`, loaded from `root`; skips a split with errors or one its config ignores. */
export async function lintFront(files: SplitResult[], root: string): Promise<FrontLintDiagnostic[]> {
  const bin = oxlintBin(root);
  const groups = new Map<string | undefined, SplitResult[]>();
  for (const split of files) {
    const fileName = resolve(root, split.filename);
    if (split.errors.length > 0 || ignoringConfig(fileName, root)) continue;
    const config = lintConfig(fileName);
    groups.set(config, [...(groups.get(config) ?? []), split]);
  }
  const diagnostics: FrontLintDiagnostic[] = [];
  for (const [config, splits] of groups) diagnostics.push(...(await lintGroup(bin, config, splits, root)));
  return diagnostics;
}

function lintFinding(diagnostic: FrontLintDiagnostic, split: SplitResult): Finding {
  const at = (offset: number) => {
    const {line, column} = locate(split.source, offset);
    return {line, column: column + 1};
  };
  return {
    file: diagnostic.file,
    ...at(diagnostic.start),
    end: at(diagnostic.end),
    code: diagnostic.code,
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    message: diagnostic.message,
    block: diagnostic.block,
    framework: diagnostic.block,
  };
}

async function run(values: CommandValues, paths: string[]): Promise<CommandResult> {
  const cwd = process.cwd();
  oxlintBin(cwd);
  const ignoredBy = (file: string) => {
    const config = ignoringConfig(file, cwd);
    return config && rootRelativePath(cwd, config);
  };
  const files = frontFiles(paths, ignoredBy, 'lint it with oxlint');
  const findings: Finding[] = [];
  const splits = new Map<string, SplitResult>();
  for (const file of files) {
    const split = splitBlocks(readFileSync(file, 'utf8'), file);
    findings.push(...split.errors.map((error) => findingOf(error, split)));
    splits.set(file, split);
  }
  for (const diagnostic of await lintFront([...splits.values()], cwd)) {
    findings.push(lintFinding(diagnostic, splits.get(diagnostic.file)!));
  }
  return {
    findings,
    summary: `linted ${counted(files.length, 'file')}: ${problems(findings) || 'no problems'}`,
    data: {files: files.length},
    warningsFail: values['deny-warnings'] === true,
  };
}

export function runMfLint(args: string[]): Promise<number> {
  return runCommand(MF_LINT, args, run);
}
