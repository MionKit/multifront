/** Shared by every multifront command: text or `--format json`, `Finding`s, exit codes 0/1/2, `--help`, option errors. */
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import type {ParseArgsOptionsConfig} from 'node:util';
import {locate, orList} from './diagnostics.ts';
import {rootRelativePath} from './scopeId.ts';
import type {CommandOption, CommandResult, CommandSpec, CommandValues, Diagnostic, Finding, SplitResult} from './types.ts';

const FORMATS = ['text', 'json'];
const SHARED_OPTIONS: Record<string, CommandOption> = {
  format: {type: 'string', value: '<format>', description: 'text or json (default: text)'},
  help: {type: 'boolean', short: 'h', description: 'show this help'},
};
const EXIT_CODES = 'Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).';

/** A `.ucf` diagnostic with 1-based positions and the block it falls in. */
export function findingOf(diagnostic: Diagnostic, split: Pick<SplitResult, 'source' | 'blocks'>): Finding {
  const {filename, line, column, start, end, code, severity, message} = diagnostic;
  const last = locate(split.source, end);
  const block = split.blocks.find((candidate) => candidate.start <= start && start < candidate.end)?.type;
  const position = {line, column: column + 1, end: {line: last.line, column: last.column + 1}};
  return {file: filename, ...position, code, severity, message, ...(block && {block})};
}

function helpText(spec: CommandSpec, options: Record<string, CommandOption>): string {
  const rows = Object.entries(options).map(([name, {short, value, description}]) => {
    const flag = short ? `-${short}, --${name}` : `--${name}`;
    return [value ? `${flag} ${value}` : flag, description] as const;
  });
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 3;
  return [
    `Usage: ${spec.name} [options]${spec.paths ? ' [paths...]' : ''}`,
    '',
    ...spec.summary,
    ...(spec.paths ? [spec.paths] : []),
    '',
    'Options:',
    ...rows.map(([flag, description]) => `  ${flag.padEnd(width)}${description}`),
    '',
    'Example:',
    `  ${spec.example}`,
    '',
    EXIT_CODES,
    '',
  ].join('\n');
}

function parse(
  spec: CommandSpec,
  args: string[],
  options: Record<string, CommandOption>
): {values: CommandValues; paths: string[]} {
  const config: ParseArgsOptionsConfig = Object.fromEntries(
    Object.entries(options).map(([name, {type, multiple = false, short}]) => [name, {type, multiple, ...(short && {short})}])
  );
  // Non-strict first: its tokens name an unknown option as written, before any value check.
  const {tokens} = parseArgs({args, options: config, strict: false, allowPositionals: true, tokens: true});
  for (const token of tokens) {
    if (token.kind === 'positional' && !spec.paths) {
      throw new Error(`unexpected argument '${token.value}'; ${spec.name} takes options only`);
    }
    if (token.kind === 'option' && !(token.name in options)) {
      const names = Object.keys(options).map((name) => `--${name}`);
      throw new Error(`unknown option '${token.rawName}'; use ${orList(names)}`);
    }
  }
  // Strict: a missing value, or a value on a boolean, throws node's own message.
  const {values, positionals} = parseArgs({args, options: config, strict: true, allowPositionals: !!spec.paths});
  if (values.format !== undefined && !FORMATS.includes(values.format as string)) {
    throw new Error(`unknown format '${values.format}'; use ${orList(FORMATS)}`);
  }
  return {values, paths: positionals};
}

function count(findings: Finding[], severity: Finding['severity']): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function compareFindings(one: Finding, other: Finding): number {
  const keys = (finding: Finding) => [finding.file ?? '', finding.line ?? 0, finding.column ?? 0, finding.code] as const;
  const [ours, theirs] = [keys(one), keys(other)];
  for (let index = 0; index < ours.length; index++) {
    if (ours[index]! < theirs[index]!) return -1;
    if (ours[index]! > theirs[index]!) return 1;
  }
  return 0;
}

function findingLine({file, line, column, severity, code, framework, message}: Finding): string {
  const position = line === undefined ? '' : `:${line}:${column}`;
  const where = file === undefined ? '' : `${file}${position}: `;
  return `${where}${severity} ${code}${framework ? ` (${framework})` : ''}: ${message}`;
}

export async function runCommand(
  spec: CommandSpec,
  args: string[],
  run: (values: CommandValues, paths: string[]) => Promise<CommandResult>
): Promise<number> {
  const options = {...spec.options, ...SHARED_OPTIONS};
  try {
    const {values, paths} = parse(spec, args, options);
    if (values.help) {
      process.stdout.write(helpText(spec, options));
      return 0;
    }
    const cwd = process.cwd();
    const missing = paths.find((path) => !existsSync(resolve(cwd, path)));
    if (missing !== undefined) throw new Error(`${missing} does not exist`);
    const result = await run(
      values,
      paths.map((path) => resolve(cwd, path))
    );
    const findings = result.findings
      .map((finding) => (finding.file === undefined ? finding : {...finding, file: rootRelativePath(cwd, finding.file)}))
      .sort(compareFindings);
    if (values.format === 'json') {
      const errorCount = count(findings, 'error');
      const document = {findings, errorCount, warningCount: count(findings, 'warning'), ...result.data};
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    } else {
      const lines = [...findings.map(findingLine), `${spec.name}: ${result.summary}`];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    const failed = count(findings, 'error') > 0 || (result.warningsFail === true && count(findings, 'warning') > 0);
    return failed ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${spec.name}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}
