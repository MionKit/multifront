/** `mf-fmt`: oxfmt's `format()` on each block's own text, put back between the block's tags (spec 6.1). */
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {extname} from 'node:path';
import {blockScripts, createDiagnostic, findingOf, rootRelativePath, runCommand, splitBlocks} from '@multifront/core';
import type {Block, CommandResult, CommandSpec, CommandValues, DiagnosticCode, Finding, SplitResult} from '@multifront/core';
import type * as OxfmtModule from 'oxfmt';
import {blockFile} from '../blocks/blockFile.ts';
import {isIgnored, projectImport, resolveInProject, ucfFiles} from '../files.ts';
import {lineStarts} from '../mappings.ts';
import type {FormattedUcf, UcfFormatConfig} from '../types.ts';
import {findFormatConfig, formatOptions} from './config.ts';

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

export const MISSING_SVELTE =
  'oxfmt cannot load svelte/compiler, so <svelte> blocks stay as written; add svelte to devDependencies';

const oxfmtMissing = (root: string) => `oxfmt is not installed in ${root}; add it to devDependencies`;
const projectOxfmt = (root: string) => projectImport<Oxfmt>(root, 'oxfmt', oxfmtMissing(root));

// oxfmt requires `svelte/compiler` from its own folder, where pnpm links svelte only as oxfmt's peer.
function oxfmtLoadsSvelte(root: string): boolean {
  const oxfmt = resolveInProject(root, 'oxfmt', oxfmtMissing(root)).path;
  try {
    createRequire(oxfmt).resolve('svelte/compiler');
    return true;
  } catch (err) {
    // Found but broken: its own error says why.
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return false;
    throw err;
  }
}

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

// Mirrors oxfmt's embed parser per `lang`; any other lang is not JavaScript.
const SCRIPT_ENDINGS: Record<string, string> = {'': 'jsx', js: 'jsx', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx'};

// oxfmt 0.67.0 leaves an unparsable <script> as is with no error, and logs a stack for svelte.
async function scriptError(format: Oxfmt['format'], block: Block): Promise<{block: Block; error: OxfmtError} | undefined> {
  for (const script of blockScripts(block)) {
    const lang = typeof script.attrs.lang === 'string' ? script.attrs.lang : '';
    if (!Object.hasOwn(SCRIPT_ENDINGS, lang)) continue;
    const [error] = (await format(`script.${SCRIPT_ENDINGS[lang]}`, script.content, {})).errors;
    if (error) return {block: script, error};
  }
  return undefined;
}

const configRejection = (errors: OxfmtError[]) =>
  errors.find(({message, labels}) => labels.length === 0 && message.startsWith(CONFIG_ERROR));

/** Text outside the blocks stays byte for byte; a config oxfmt rejects throws. */
export async function formatUcf(fileName: string, source: string, config: UcfFormatConfig): Promise<FormattedUcf> {
  const split = splitBlocks(source, fileName);
  if (split.errors.length > 0) {
    return {text: source, findings: split.errors.map((error) => findingOf(error, split)), missingSvelte: false};
  }
  const {format} = await projectOxfmt(config.root);
  let svelteLoads: boolean | undefined;
  let missingSvelte = false;
  const sent = split.blocks.flatMap((block) => {
    const file = blockFile(fileName, block);
    const {own, options} = formatOptions(config, file) as {own: FormatConfig; options: FormatConfig};
    const ending = extname(file);
    if (FORMATTED.has(ending)) return [{block, file, own, options}];
    // oxfmt's `svelte` option: `true` or an object turns it on.
    if (ending !== '.svelte' || !options.svelte) return [];
    svelteLoads ??= oxfmtLoadsSvelte(config.root);
    missingSvelte ||= !svelteLoads;
    return svelteLoads ? [{block, file, own, options}] : [];
  });
  const results = await Promise.all(
    sent.map(async ({block, file, own, options}) => {
      const broken = await scriptError(format, block);
      // An empty text still checks the config, and logs no stack.
      const {code, errors} = await format(file, broken ? '' : block.content, options);
      const rejected = configRejection(errors);
      if (rejected) {
        // The `.oxfmtrc.json` alone passes: a value the `.editorconfig` filled in is the one rejected.
        const fromEditorConfig = !configRejection((await format(file, '', own)).errors);
        const blamed = fromEditorConfig ? config.editorconfig!.file : config.file!;
        throw new Error(`${rootRelativePath(config.root, blamed)}: ${rejected.message.slice(CONFIG_ERROR.length).trim()}`);
      }
      if (broken) return {block: broken.block, errors: [broken.error], content: ''};
      const newline = NEWLINES[options.endOfLine ?? 'lf'];
      const trimmed = code.replace(/[\r\n]+$/, '');
      return {block, errors, content: trimmed ? `${newline}${trimmed}${newline}` : ''};
    })
  );
  const findings = results.flatMap(({block, errors}) => (errors[0] ? [formatError(split, block, errors[0])] : []));
  if (findings.length > 0) return {text: source, findings, missingSvelte};
  let text = source;
  // From the last block back, so earlier offsets stay valid.
  for (const {block, content} of results.reverse()) {
    text = text.slice(0, block.contentStart) + content + text.slice(block.contentEnd);
  }
  return {text, findings: [], missingSvelte};
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
  let missingSvelte = false;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const formatted = await formatUcf(file, source, findFormatConfig(file, cwd));
    findings.push(...formatted.findings);
    missingSvelte ||= formatted.missingSvelte;
    if (formatted.findings.length > 0 || formatted.text === source) continue;
    writes.push([file, formatted.text]);
    if (!values.check) continue;
    const split = splitBlocks(source, file);
    const at = firstDifference(source, formatted.text);
    const message = `not formatted; run mf-fmt ${shown(file)}`;
    findings.push(findingOf(createDiagnostic(split, 'unformatted', at, at, message), split));
  }
  if (missingSvelte)
    findings.push({code: 'missing-svelte' satisfies DiagnosticCode, severity: 'warning', message: MISSING_SVELTE});
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
