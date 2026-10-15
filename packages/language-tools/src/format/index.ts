/** `mf-fmt`: oxfmt's `format()` on each block's own text, put back between the block's tags (spec 6.1). */
import {readFileSync, writeFileSync} from 'node:fs';
import {extname} from 'node:path';
import {createDiagnostic, findingOf, rootRelativePath, runCommand, splitBlocks} from '@multifront/core';
import type {Block, CommandResult, CommandSpec, CommandValues, Finding, SplitResult} from '@multifront/core';
import type * as OxfmtModule from 'oxfmt';
import {blockFile} from '../blocks/blockFile.ts';
import {projectImport, ucfFiles} from '../files.ts';
import {lineStarts} from '../mappings.ts';
import type {FormattedUcf, UcfFormatConfig} from '../types.ts';
import {findFormatConfig, formatOptions, isIgnored} from './config.ts';

export {findFormatConfig} from './config.ts';

const MF_FMT: CommandSpec = {
  name: 'mf-fmt',
  summary: ["Formats each block of .ucf files with oxfmt and the project's .oxfmtrc.json."],
  paths: 'Paths are .ucf files or folders; none formats every .ucf file under the current folder.',
  options: {check: {type: 'boolean', description: 'write nothing; list the files that are not formatted'}},
  example: 'mf-fmt --check src/Card.ucf',
};

type Oxfmt = Pick<typeof OxfmtModule, 'format'>;
type FormatConfig = NonNullable<Parameters<Oxfmt['format']>[2]>;
type OxfmtError = Awaited<ReturnType<Oxfmt['format']>>['errors'][number];

// The endings oxfmt formats with no plugin; any other block stays as written.
const FORMATTED = new Set(['.tsx', '.vue', '.css', '.scss', '.less']);
const CONFIG_ERROR = 'Failed to parse configuration: ';
const NEWLINES: Record<NonNullable<FormatConfig['endOfLine']>, string> = {lf: '\n', cr: '\r', crlf: '\r\n'};

const projectOxfmt = (root: string) =>
  projectImport<Oxfmt>(root, 'oxfmt', `oxfmt is not installed in ${root}; add it to devDependencies`);

// oxc labels count UTF-8 bytes; no label: Prettier's 1-based `(line:col)` ending line 1; else the opening tag.
function errorSpan(error: OxfmtError, block: Block): [number, number] {
  const [label] = error.labels;
  if (label) {
    const bytes = Buffer.from(block.content);
    const at = (offset: number) => block.contentStart + bytes.subarray(0, offset).toString().length;
    return [at(label.start), at(label.end)];
  }
  const loc = /\((\d+):(\d+)\)$/.exec(error.message.split('\n')[0]!);
  if (!loc) return [block.start, block.contentStart];
  const at = block.contentStart + lineStarts(block.content)[Number(loc[1]) - 1]! + Number(loc[2]) - 1;
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

const configRejection = (errors: OxfmtError[]) =>
  errors.find(({message, labels}) => labels.length === 0 && message.startsWith(CONFIG_ERROR));

/** Text outside the blocks stays byte for byte; a config oxfmt rejects throws. */
export async function formatUcf(fileName: string, source: string, config: UcfFormatConfig): Promise<FormattedUcf> {
  const split = splitBlocks(source, fileName);
  if (split.errors.length > 0) return {text: source, findings: split.errors.map((error) => findingOf(error, split))};
  const {format} = await projectOxfmt(config.root);
  const sent = split.blocks.filter((block) => FORMATTED.has(extname(blockFile(fileName, block))));
  const results = await Promise.all(
    sent.map(async (block) => {
      const file = blockFile(fileName, block);
      const {own, options} = formatOptions(config, file) as {own: FormatConfig; options: FormatConfig};
      const {code, errors} = await format(file, block.content, options);
      const rejected = configRejection(errors);
      if (rejected) {
        // The `.oxfmtrc.json` alone passes: a value the `.editorconfig` filled in is the one rejected.
        const fromEditorConfig = !configRejection((await format(file, '', own)).errors);
        const blamed = fromEditorConfig ? config.editorconfig!.file : config.file!;
        throw new Error(`${rootRelativePath(config.root, blamed)}: ${rejected.message.slice(CONFIG_ERROR.length).trim()}`);
      }
      const newline = NEWLINES[options.endOfLine ?? 'lf'];
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
  const ignoredBy = (file: string) => {
    const config = findFormatConfig(file, cwd);
    return isIgnored(config, file) ? shown(config.file!) : undefined;
  };
  const files = ucfFiles(paths, ignoredBy, 'format it with oxfmt');
  const findings: Finding[] = [];
  const writes: [string, string][] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const formatted = await formatUcf(file, source, findFormatConfig(file, cwd));
    findings.push(...formatted.findings);
    if (formatted.findings.length > 0 || formatted.text === source) continue;
    writes.push([file, formatted.text]);
    if (!values.check) continue;
    const split = splitBlocks(source, file);
    const at = firstDifference(source, formatted.text);
    const message = `not formatted; run mf-fmt ${shown(file)}`;
    findings.push(findingOf(createDiagnostic(split, 'unformatted', at, at, message), split));
  }
  // Only once every file formatted: a config error in a later file (exit 2) leaves every file as written.
  if (!values.check) for (const [file, text] of writes) writeFileSync(file, text);
  const count = `${writes.length} of ${files.length} files`;
  return {
    findings,
    summary: values.check ? `${count} not formatted` : `formatted ${count}`,
    data: {files: files.length, changed: writes.map(([file]) => shown(file))},
  };
}

export function runMfFmt(args: string[]): Promise<number> {
  return runCommand(MF_FMT, args, run);
}
