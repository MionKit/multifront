/** `mf-lint`: each block's own text as a temporary file, linted by the project's oxlint, positions mapped back (spec 6.1). */
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, parse, sep} from 'node:path';
import {promisify} from 'node:util';
import {findingOf, locate, moduleName, rootRelativePath, runCommand, splitBlocks} from '@multifront/core';
import type {Block, CommandResult, CommandSpec, CommandValues, Finding, SplitResult, Target} from '@multifront/core';
import {blockFile} from '../blocks/blockFile.ts';
import {isIgnored, nearestFile, parseJsonc, resolveInProject, slashed, ucfFiles} from '../files.ts';
import type {LintOptions, UcfLintDiagnostic} from '../types.ts';

const MF_LINT: CommandSpec = {
  name: 'mf-lint',
  summary: ["Lints each block of .ucf files with oxlint and the project's .oxlintrc.json."],
  paths: 'Paths are .ucf files or folders; none lints every .ucf file under the current folder.',
  options: {'deny-warnings': {type: 'boolean', description: 'exit 1 on warnings too'}},
  example: 'mf-lint src/Card.ucf --format json',
};

const CONFIG_NAMES = ['.oxlintrc.json', '.oxlintrc.jsonc'];
const WRAPPER = '.oxlintrc.json';

interface OxlintDiagnostic {
  message: string;
  code: string;
  severity: UcfLintDiagnostic['severity'];
  url?: string;
  help?: string;
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
  const {bin} = JSON.parse(readFileSync(manifest, 'utf8')) as {bin: string | Record<string, string>};
  return join(dirname(manifest), typeof bin === 'string' ? bin : bin.oxlint!);
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

/** The config that ignores `fileName`, if any. */
function ignoringConfig(fileName: string, root: string): string | undefined {
  const config = lintConfig(fileName);
  return config && isIgnored({file: config, ignorePatterns: ignorePatterns(config, root)}, fileName) ? config : undefined;
}

// oxlint prints a bad config on stdout as a miette report: one line for spec 8.1's single stderr line.
function oxlintFailure(stdout: string, stderr: string, root: string): Error {
  const lines = (stderr.trim() || stdout.trim())
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[x×|│]\s)?/, '').trim())
    .filter(Boolean);
  return new Error(`oxlint: ${lines.join(' ').replaceAll(`${root}${sep}`, '')}`);
}

async function runOxlint(bin: string, cwd: string, root: string): Promise<OxlintDiagnostic[]> {
  const args = [bin, '-c', WRAPPER, '-f', 'json', '.'];
  let output: {stdout: string; stderr: string};
  try {
    output = await promisify(execFile)(process.execPath, args, {cwd, maxBuffer: Infinity, encoding: 'utf8'});
  } catch (err) {
    const {code, stdout = '', stderr = ''} = err as {code?: number | string; stdout?: string; stderr?: string};
    if (code !== 1) throw oxlintFailure(stdout, stderr || String(err), root);
    output = {stdout, stderr};
  }
  try {
    const {diagnostics} = JSON.parse(output.stdout) as {diagnostics?: OxlintDiagnostic[]};
    if (Array.isArray(diagnostics)) return diagnostics;
  } catch {
    // Not its JSON report: a bad config exits 1 with a plain message.
  }
  throw oxlintFailure(output.stdout, output.stderr, root);
}

async function lintGroup(bin: string, config: string | undefined, splits: SplitResult[], root: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mf-lint-'));
  try {
    const written = new Map<string, Written>();
    const overrides: {files: string[]; globals: Record<string, 'readonly'>}[] = [];
    for (const split of splits) {
      // Relative to the config's folder, where oxlint anchors the `overrides` globs of the config it extends.
      const relative = rootRelativePath(config ? dirname(config) : parse(split.filename).root, split.filename);
      const files: string[] = [];
      for (const block of split.blocks.filter(({type}) => type !== 'style')) {
        const file = slashed(blockFile(relative, block));
        await mkdir(dirname(join(dir, file)), {recursive: true});
        await writeFile(join(dir, file), block.content);
        written.set(file, {split, block, bytes: Buffer.from(block.content)});
        files.push(file);
      }
      const modules = split.styles.flatMap((style) => moduleName(style) ?? []).filter((name) => name !== '$style');
      if (files.length > 0 && modules.length > 0) {
        overrides.push({files, globals: Object.fromEntries(modules.map((name) => [name, 'readonly' as const]))});
      }
    }
    if (written.size === 0) return [];
    const wrapper = {...(config && {extends: [config]}), globals: {$style: 'readonly'}, overrides};
    await writeFile(join(dir, WRAPPER), JSON.stringify(wrapper));
    return (await runOxlint(bin, dir, root)).map((diagnostic): UcfLintDiagnostic => {
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
        code,
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

/** One oxlint run per nearest `.oxlintrc.json`; a split with errors, or one its config ignores, is not linted. */
export async function lintUcf(files: SplitResult[], {root}: LintOptions): Promise<UcfLintDiagnostic[]> {
  const bin = oxlintBin(root);
  const groups = new Map<string | undefined, SplitResult[]>();
  for (const split of files) {
    if (split.errors.length > 0 || ignoringConfig(split.filename, root)) continue;
    const config = lintConfig(split.filename);
    groups.set(config, [...(groups.get(config) ?? []), split]);
  }
  const diagnostics: UcfLintDiagnostic[] = [];
  for (const [config, splits] of groups) diagnostics.push(...(await lintGroup(bin, config, splits, root)));
  return diagnostics;
}

function lintFinding(diagnostic: UcfLintDiagnostic, split: SplitResult): Finding {
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
  const files = ucfFiles(paths, ignoredBy, 'lint it with oxlint');
  const findings: Finding[] = [];
  const splits = new Map<string, SplitResult>();
  for (const file of files) {
    const split = splitBlocks(readFileSync(file, 'utf8'), file);
    findings.push(...split.errors.map((error) => findingOf(error, split)));
    splits.set(file, split);
  }
  for (const diagnostic of await lintUcf([...splits.values()], {root: cwd})) {
    findings.push(lintFinding(diagnostic, splits.get(diagnostic.file)!));
  }
  const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const errors = findings.filter(({severity}) => severity === 'error').length;
  const warnings = findings.length - errors;
  const problems = [errors && counted(errors, 'error'), warnings && counted(warnings, 'warning')].filter(Boolean).join(', ');
  return {
    findings,
    summary: `linted ${counted(files.length, 'file')}: ${problems || 'no problems'}`,
    data: {files: files.length},
    warningsFail: values['deny-warnings'] === true,
  };
}

export function runMfLint(args: string[]): Promise<number> {
  return runCommand(MF_LINT, args, run);
}
