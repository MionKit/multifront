/** oxfmt's config, read as its CLI reads it: oxfmt's `format()` takes resolved options only. */
import {readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {rootRelativePath} from '@multifront/core';
import ignore from 'ignore';
import {minimatch} from 'minimatch';
import {nearestFile, parseJsonc} from '../files.ts';
import type {EditorConfigFile, FormatOptions, FormatOverride, UcfFormatConfig} from '../types.ts';

const CONFIG_NAMES = ['.oxfmtrc.json', '.oxfmtrc.jsonc'];

/** The `.oxfmtrc.json` nearest above `dir`; a nested one replaces its parent, nothing inherited. */
export function formatConfigFile(dir: string): string | undefined {
  return nearestFile(dir, CONFIG_NAMES);
}

function readEditorConfig(root: string): EditorConfigFile | undefined {
  const file = nearestFile(root, ['.editorconfig']);
  if (!file) return undefined;
  const sections: EditorConfigFile['sections'] = [];
  for (const line of readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((text) => text.trim())) {
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.*)\]$/.exec(line);
    if (section) sections.push({glob: section[1]!, properties: {}});
    // Lines before the first section (`root = true`) set nothing oxfmt reads.
    else if (line.includes('=') && sections.length > 0) {
      const at = line.indexOf('=');
      sections.at(-1)!.properties[line.slice(0, at).trim().toLowerCase()] = line
        .slice(at + 1)
        .trim()
        .toLowerCase();
    }
  }
  return {file, sections};
}

/** `file` undefined: oxfmt's defaults, with the `.editorconfig` still read. */
export function readFormatConfig(file: string | undefined, root: string): UcfFormatConfig {
  const raw = file ? parseJsonc(file, root) : {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${rootRelativePath(root, file!)}: not a JSON object`);
  }
  const {overrides = [], ignorePatterns = [], $schema: _schema, ...options} = raw as FormatOptions;
  const editorconfig = readEditorConfig(root);
  return {
    root,
    ...(file && {file}),
    options,
    overrides: overrides as FormatOverride[],
    ignorePatterns: ignorePatterns as string[],
    ...(editorconfig && {editorconfig}),
  };
}

/** The config the oxfmt CLI would use for `fileName` run from `root`. */
export function findFormatConfig(fileName: string, root: string): UcfFormatConfig {
  return readFormatConfig(formatConfigFile(dirname(fileName)), root);
}

// oxfmt's rule: a pattern with no `/` matches at any depth; a leading `./` anchors it to the config's folder.
function overrideGlob(pattern: string): string {
  const anchored = pattern.startsWith('./');
  const glob = anchored ? pattern.slice(2) : pattern;
  return anchored || glob.includes('/') ? glob : `**/${glob}`;
}

// editorconfig's rule: a leading `/` anchors, else a section with no `/` matches at any depth.
function sectionGlob(glob: string): string {
  if (glob.startsWith('/')) return glob.slice(1);
  return glob.includes('/') ? glob : `**/${glob}`;
}

const matches = (path: string, glob: string) => minimatch(path, glob, {dot: true});

function editorProperties(editorconfig: EditorConfigFile | undefined, path: string): Record<string, string> {
  if (!editorconfig) return {};
  const relative = rootRelativePath(dirname(editorconfig.file), path);
  const matching = editorconfig.sections.filter(({glob}) => matches(relative, sectionGlob(glob)));
  return Object.assign({}, ...matching.map(({properties}) => properties));
}

const numberOf = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined);
const choice = <Value>(value: string | undefined, values: Record<string, Value>) =>
  value !== undefined && Object.hasOwn(values, value) ? values[value] : undefined;

/** Base options, then each matching override in order, then the `.editorconfig` for fields still unset. */
export function formatOptions(config: UcfFormatConfig, blockPath: string): FormatOptions {
  const options: FormatOptions = {...config.options};
  const relative = config.file ? rootRelativePath(dirname(config.file), blockPath) : blockPath;
  const any = (patterns: string[] = []) => patterns.some((pattern) => matches(relative, overrideGlob(pattern)));
  for (const override of config.overrides) {
    if (any(override.files) && !any(override.excludeFiles)) Object.assign(options, override.options);
  }
  const props = editorProperties(config.editorconfig, blockPath);
  const fill = (key: string, value: unknown) => {
    if (options[key] === undefined && value !== undefined) options[key] = value;
  };
  fill('printWidth', numberOf(props.max_line_length));
  fill('endOfLine', choice(props.end_of_line, {lf: 'lf', cr: 'cr', crlf: 'crlf'}));
  fill('useTabs', choice(props.indent_style, {tab: true, space: false}));
  // Prettier's rule: `indent_size` only with spaces.
  const indentSize = options.useTabs === false ? numberOf(props.indent_size) : undefined;
  fill('tabWidth', indentSize ?? numberOf(props.tab_width));
  fill('insertFinalNewline', choice(props.insert_final_newline, {true: true, false: false}));
  fill('singleQuote', choice(props.quote_type, {single: true, double: false}));
  return options;
}

/** `ignorePatterns` are gitignore lines rooted at the config's folder. */
export function isIgnored(config: UcfFormatConfig, fileName: string): boolean {
  if (!config.file || config.ignorePatterns.length === 0) return false;
  const path = rootRelativePath(dirname(config.file), fileName);
  return !path.startsWith('../') && ignore().add(config.ignorePatterns).ignores(path);
}
