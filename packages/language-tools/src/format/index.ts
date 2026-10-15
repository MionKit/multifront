/** `mf-fmt`: oxfmt's `format()` on each block's own text, put back between the block's tags (spec 6.1). */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, extname} from 'node:path';
import {createDiagnostic, findingOf, rootRelativePath, runCommand, splitBlocks} from '@multifront/core';
import type {Block, CommandResult, CommandSpec, CommandValues, Finding, SplitResult} from '@multifront/core';
import {blockFile} from '../blocks/blockFile.ts';
import {projectImport, ucfFiles} from '../files.ts';
import type {FormattedUcf, UcfFormatConfig} from '../types.ts';
import {formatConfigFile, formatOptions, isIgnored, readFormatConfig} from './config.ts';

export {findFormatConfig} from './config.ts';

const MF_FMT: CommandSpec = {
  name: 'mf-fmt',
  summary: ["Formats each block of .ucf files with oxfmt and the project's .oxfmtrc.json."],
  paths: 'Paths are .ucf files or folders; none formats every .ucf file under the current folder.',
  options: {check: {type: 'boolean', description: 'write nothing; list the files that are not formatted'}},
  example: 'mf-fmt --check src/Card.ucf',
};

// The endings oxfmt formats with no plugin; any other block stays as written.
const FORMATTED = new Set(['.tsx', '.vue', '.css', '.scss', '.less']);
const CONFIG_ERROR = 'Failed to parse configuration: ';
const NEWLINES: Record<string, string> = {lf: '\n', cr: '\r', crlf: '\r\n'};

interface OxfmtError {
  message: string;
  labels: {start: number; end: number}[];
}

interface Oxfmt {
  format(fileName: string, source: string, options: Record<string, unknown>): Promise<{code: string; errors: OxfmtError[]}>;
}

const oxfmts = new Map<string, Promise<Oxfmt>>();

/** The project's own oxfmt, loaded once per root. */
function projectOxfmt(root: string): Promise<Oxfmt> {
  let oxfmt = oxfmts.get(root);
  if (!oxfmt) {
    oxfmt = projectImport<Oxfmt>(root, 'oxfmt', `oxfmt is not installed in ${root}; add it to devDependencies`);
    oxfmts.set(root, oxfmt);
  }
  return oxfmt;
}

// A label's span; else Prettier's `(line:col)` ending the first message line; else the opening tag.
function errorSpan(error: OxfmtError, block: Block): [number, number] {
  const [label] = error.labels;
  if (label) return [block.contentStart + label.start, block.contentStart + label.end];
  const loc = /\((\d+):(\d+)\)$/.exec(error.message.split('\n')[0]!);
  if (!loc) return [block.start, block.contentStart];
  const lineStart = block.content
    .split('\n')
    .slice(0, Number(loc[1]) - 1)
    .join('\n').length;
  const at = block.contentStart + (Number(loc[1]) > 1 ? lineStart + 1 : 0) + Number(loc[2]) - 1;
  return [at, at];
}

function formatError(split: SplitResult, block: Block, error: OxfmtError): Finding {
  const why = error.message
    .split('\n')[0]!
    .replace(/^SyntaxError: /, '')
    .replace(/\s*\(\d+:\d+\)$/, '');
  const [start, end] = errorSpan(error, block);
  return findingOf(createDiagnostic(split, 'format-error', start, end, `<${block.type}> does not parse: ${why}`), split);
}

/** Text outside the blocks stays byte for byte; a config oxfmt rejects throws. */
export async function formatUcf(fileName: string, source: string, config: UcfFormatConfig): Promise<FormattedUcf> {
  const split = splitBlocks(source, fileName);
  if (split.errors.length > 0) return {text: source, findings: split.errors.map((error) => findingOf(error, split))};
  const {format} = await projectOxfmt(config.root);
  const sent = split.blocks.filter((block) => FORMATTED.has(extname(blockFile(fileName, block))));
  const results = await Promise.all(
    sent.map(async (block) => {
      const file = blockFile(fileName, block);
      const options = formatOptions(config, file);
      const {code, errors} = await format(file, block.content, options);
      const rejected = errors.find(({message, labels}) => labels.length === 0 && message.startsWith(CONFIG_ERROR));
      if (rejected) {
        const shown = rootRelativePath(config.root, (config.file ?? config.editorconfig?.file)!);
        throw new Error(`${shown}: ${rejected.message.slice(CONFIG_ERROR.length).trim()}`);
      }
      const newline = NEWLINES[options.endOfLine as string] ?? '\n';
      const trimmed = code.replace(/[\r\n]+$/, '');
      return {block, errors, content: trimmed ? `${newline}${trimmed}${newline}` : ''};
    })
  );
  const findings = results.flatMap(({block, errors}) => (errors[0] ? [formatError(split, block, errors[0])] : []));
  if (findings.length > 0) return {text: source, findings};
  let text = source;
  // From the last block back, so earlier offsets stay valid.
  for (const {block, content} of results.reverse()) {
    text = text.slice(0, block.contentStart) + content + text.slice(block.contentEnd);
  }
  return {text, findings: []};
}

function firstDifference(source: string, text: string): number {
  let at = 0;
  while (at < source.length && source[at] === text[at]) at++;
  return at;
}

async function run(values: CommandValues, paths: string[]): Promise<CommandResult> {
  const cwd = process.cwd();
  await projectOxfmt(cwd);
  const shown = (path: string) => rootRelativePath(cwd, path);
  const configs = new Map<string | undefined, UcfFormatConfig>();
  const configOf = (file: string): UcfFormatConfig => {
    const path = formatConfigFile(dirname(file));
    if (!configs.has(path)) configs.set(path, readFormatConfig(path, cwd));
    return configs.get(path)!;
  };
  const files = ucfFiles(
    paths,
    (file) => {
      const config = configOf(file);
      return isIgnored(config, file) ? shown(config.file!) : undefined;
    },
    'format it with oxfmt'
  );
  const findings: Finding[] = [];
  const changed: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const formatted = await formatUcf(file, source, configOf(file));
    findings.push(...formatted.findings);
    if (formatted.findings.length > 0 || formatted.text === source) continue;
    changed.push(shown(file));
    if (!values.check) {
      writeFileSync(file, formatted.text);
      continue;
    }
    const split = splitBlocks(source, file);
    const at = firstDifference(source, formatted.text);
    const message = `not formatted; run mf-fmt ${shown(file)}`;
    findings.push(findingOf(createDiagnostic(split, 'unformatted', at, at, message), split));
  }
  const count = `${changed.length} of ${files.length} files`;
  return {
    findings,
    summary: values.check ? `${count} not formatted` : `formatted ${count}`,
    data: {files: files.length, changed},
  };
}

export function runMfFmt(args: string[]): Promise<number> {
  return runCommand(MF_FMT, args, run);
}
